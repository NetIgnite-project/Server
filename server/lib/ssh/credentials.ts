import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { AgentProtocol } from "../agents/protocol";
import { AgentRegistry } from "../agents/registry";
import type { DeviceSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";
import { Secrets } from "../utils/secrets";
import { SshKeys } from "./keys";

/**
 * SSH logins of devices: the device's agent (in the same network) logs in to check the login and
 * to shut the device down or reboot it. Passwords and private keys are stored encrypted
 * ({@link Secrets}) and only sent to that agent. Host keys are trusted on first use: the owner
 * confirms the fingerprint of a test login; later logins to another key fail.
 */
export class SshCredentials {
	static get(deviceID: number) {
		return (
			DB.instance()
				.select()
				.from(DB.Tables.deviceSshCredentials)
				.where(eq(DB.Tables.deviceSshCredentials.device_id, deviceID))
				.get() ?? null
		);
	}

	/** Devices (of `deviceIDs`) whose SSH login has a trusted host key. */
	static trustedDeviceIDs(deviceIDs: number[]) {
		if (deviceIDs.length === 0) return new Set<number>();
		const rows = DB.instance()
			.select({ device_id: DB.Tables.deviceSshCredentials.device_id })
			.from(DB.Tables.deviceSshCredentials)
			.where(
				and(
					inArray(DB.Tables.deviceSshCredentials.device_id, deviceIDs),
					isNotNull(DB.Tables.deviceSshCredentials.host_key),
				),
			)
			.all();
		return new Set(rows.map((row) => row.device_id));
	}

	/** Stores the login. The host key stays trusted only if host and port are unchanged. */
	static save(device: DB.Models.Device, input: SshCredentials.Input) {
		const existing = this.get(device.id);

		let secret: string;
		let publicKey: string | null = null;
		let authType: DeviceSettings.SshAuthType;
		switch (input.auth.type) {
			case "password":
				authType = "password";
				secret = input.auth.password;
				break;
			case "generate_key": {
				const key = SshKeys.generateEd25519(`netignite-device-${device.id}`);
				authType = "key";
				secret = key.privateKey;
				publicKey = key.publicKey;
				break;
			}
			case "keep":
				if (!existing) throw new SshCredentialError("Enter a password or generate a key");
				authType = existing.auth_type;
				secret = Secrets.decrypt(existing.secret_encrypted);
				publicKey = existing.public_key;
				break;
		}

		const sameMachine = existing && existing.host === input.host && existing.port === input.port;
		const row = {
			device_id: device.id,
			host: input.host,
			port: input.port,
			username: input.username,
			auth_type: authType,
			secret_encrypted: Secrets.encrypt(secret),
			public_key: publicKey,
			os: input.os,
			sudo: input.sudo,
			host_key: sameMachine ? existing.host_key : null,
		};

		return DB.instance()
			.insert(DB.Tables.deviceSshCredentials)
			.values(row)
			.onConflictDoUpdate({ target: DB.Tables.deviceSshCredentials.device_id, set: row })
			.returning()
			.get();
	}

	static delete(deviceID: number) {
		DB.instance()
			.delete(DB.Tables.deviceSshCredentials)
			.where(eq(DB.Tables.deviceSshCredentials.device_id, deviceID))
			.run();
	}

	static trust(deviceID: number, hostKey: string) {
		return DB.instance()
			.update(DB.Tables.deviceSshCredentials)
			.set({ host_key: hostKey })
			.where(eq(DB.Tables.deviceSshCredentials.device_id, deviceID))
			.returning()
			.get();
	}

	/** The host the agent connects to: the login's own, or the device's status address. */
	static host(device: DB.Models.Device, credential: DB.Models.DeviceSshCredential) {
		return credential.host ?? device.status_address ?? null;
	}

	/** The login as the agent gets it (with the decrypted secret), or null without a host. */
	static target(
		device: DB.Models.Device,
		credential: DB.Models.DeviceSshCredential,
	): AgentProtocol.SshTarget | null {
		const host = this.host(device, credential);
		if (!host) return null;

		const secret = Secrets.decrypt(credential.secret_encrypted);
		return {
			host,
			port: credential.port,
			username: credential.username,
			auth:
				credential.auth_type === "password"
					? { type: "password", password: secret }
					: { type: "key", private_key: secret },
			host_key: credential.host_key,
		};
	}

	/** The device's network agent, if it can log in over SSH. */
	static agentFor(device: DB.Models.Device) {
		const connection = device.agent_id !== null ? AgentRegistry.get(device.agent_id) : null;
		return connection?.hasCapability("ssh") ? connection : null;
	}

	/** Setup instructions for the target machine. */
	static setupHints(credential: DB.Models.DeviceSshCredential) {
		const hints: { authorized_keys: string | null; sudoers: string | null } = {
			authorized_keys: null,
			sudoers: null,
		};
		if (credential.public_key) {
			// `restrict`: no forwarding, no PTY; commands still run.
			hints.authorized_keys = `restrict ${credential.public_key}`;
		}
		if (credential.os === "posix" && credential.sudo && credential.username !== "root") {
			const commands = ["/usr/sbin/shutdown", "/sbin/shutdown"].flatMap((path) => [
				`${path} -h now`,
				`${path} -r now`,
			]);
			hints.sudoers = `${credential.username} ALL=(root) NOPASSWD: ${commands.join(", ")}`;
		}
		return hints;
	}
}

export namespace SshCredentials {
	export interface Input {
		host: string | null;
		port: number;
		username: string;
		os: DeviceSettings.SshOperatingSystem;
		sudo: boolean;
		auth: { type: "password"; password: string } | { type: "generate_key" } | { type: "keep" };
	}
}

export class SshCredentialError extends Error {}
