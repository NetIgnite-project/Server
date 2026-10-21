import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { AgentProtocol } from "../agents/protocol";
import { AgentRegistry } from "../agents/registry";
import { RuntimeMetadata } from "../api/utils/metadata";
import type { DeviceSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";

/**
 * SSH logins of devices: where the device's agent (in the same network) logs in to shut the device
 * down or reboot it. Nothing secret is stored here. Every agent that can do this has two key pairs
 * of its own, one per action, and only reports the public keys. The device allows each key in its
 * authorized_keys with a forced command, so a key can do exactly its one action, even in the
 * wrong hands. Host keys are trusted on first use: the owner confirms the fingerprint of a test
 * login; logins to another key fail.
 *
 * Off unless an admin turns it on (setting `ssh_enabled`): the agent on the device itself is the
 * safer way.
 */
export class SshLogins {
	static readonly ACTIONS = ["shutdown", "reboot"] as const;

	static async enabled() {
		return (await RuntimeMetadata.getSettings()).ssh_enabled;
	}

	static get(deviceID: number) {
		return (
			DB.instance()
				.select()
				.from(DB.Tables.deviceSshLogins)
				.where(eq(DB.Tables.deviceSshLogins.device_id, deviceID))
				.get() ?? null
		);
	}

	/** Devices (of `deviceIDs`) whose SSH login has a trusted host key. */
	static trustedDeviceIDs(deviceIDs: number[]) {
		if (deviceIDs.length === 0) return new Set<number>();
		const rows = DB.instance()
			.select({ device_id: DB.Tables.deviceSshLogins.device_id })
			.from(DB.Tables.deviceSshLogins)
			.where(
				and(
					inArray(DB.Tables.deviceSshLogins.device_id, deviceIDs),
					isNotNull(DB.Tables.deviceSshLogins.host_key),
				),
			)
			.all();
		return new Set(rows.map((row) => row.device_id));
	}

	/** Stores the login. The host key stays trusted only if host and port are unchanged. */
	static save(device: DB.Models.Device, input: SshLogins.Input) {
		const existing = this.get(device.id);
		const sameMachine = existing && existing.host === input.host && existing.port === input.port;
		const row = {
			device_id: device.id,
			host: input.host,
			port: input.port,
			username: input.username,
			os: input.os,
			sudo: input.sudo,
			host_key: sameMachine ? existing.host_key : null,
		};

		return DB.instance()
			.insert(DB.Tables.deviceSshLogins)
			.values(row)
			.onConflictDoUpdate({ target: DB.Tables.deviceSshLogins.device_id, set: row })
			.returning()
			.get();
	}

	static delete(deviceID: number) {
		DB.instance()
			.delete(DB.Tables.deviceSshLogins)
			.where(eq(DB.Tables.deviceSshLogins.device_id, deviceID))
			.run();
	}

	static trust(deviceID: number, hostKey: string) {
		return DB.instance()
			.update(DB.Tables.deviceSshLogins)
			.set({ host_key: hostKey })
			.where(eq(DB.Tables.deviceSshLogins.device_id, deviceID))
			.returning()
			.get();
	}

	/** The host the agent connects to: the login's own, or the device's status address. */
	static host(device: DB.Models.Device, login: DB.Models.DeviceSshLogin) {
		return login.host ?? device.status_address ?? null;
	}

	/** Where the agent logs in, or null without a host. */
	static target(
		device: DB.Models.Device,
		login: DB.Models.DeviceSshLogin,
	): AgentProtocol.SshTarget | null {
		const host = this.host(device, login);
		if (!host) return null;
		return { host, port: login.port, username: login.username, host_key: login.host_key };
	}

	/** Whether the command runs with `sudo -n` (POSIX, and not as root). */
	static sudo(login: DB.Models.DeviceSshLogin) {
		return login.os === "posix" && login.sudo && login.username !== "root";
	}

	/** The fixed command of an action, the same one the agents request. */
	static command(action: SshLogins.Action, os: DeviceSettings.SshOperatingSystem, sudo: boolean) {
		if (os === "windows") return action === "shutdown" ? "shutdown /s /t 0" : "shutdown /r /t 0";
		const command = action === "shutdown" ? "shutdown -h now" : "shutdown -r now";
		return sudo ? `sudo -n ${command}` : command;
	}

	/** The device's network agent, if it is online and can log in over SSH. */
	static agentFor(device: DB.Models.Device) {
		const connection = device.agent_id !== null ? AgentRegistry.get(device.agent_id) : null;
		return connection?.hasCapability("ssh.power") ? connection : null;
	}

	/** The public keys the device's agent reported last (also while it is offline). */
	static agentKeys(device: DB.Models.Device) {
		if (device.agent_id === null) return null;
		const agent = DB.instance()
			.select({ ssh_keys: DB.Tables.agents.ssh_keys })
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.id, device.agent_id))
			.get();
		return agent?.ssh_keys ?? null;
	}

	/**
	 * Setup lines for the device: one authorized_keys line per agent key, each forcing its command
	 * (`restrict`: no forwarding, no terminal), and the sudoers line for POSIX with sudo.
	 */
	static setupHints(
		login: DB.Models.DeviceSshLogin,
		agentID: number | null,
		keys: AgentProtocol.SshPublicKeys | null,
	) {
		const sudo = this.sudo(login);
		const authorizedKeys =
			keys && agentID !== null
				? this.ACTIONS.map(
						(action) =>
							`restrict,command="${this.command(action, login.os, sudo)}" ${keys[action]} netignite-agent-${agentID}-${action}`,
					).join("\n")
				: null;

		let sudoers: string | null = null;
		if (sudo) {
			const commands = ["/usr/sbin/shutdown", "/sbin/shutdown"].flatMap((path) => [
				`${path} -h now`,
				`${path} -r now`,
			]);
			sudoers = `${login.username} ALL=(root) NOPASSWD: ${commands.join(", ")}`;
		}

		return {
			authorized_keys: authorizedKeys,
			authorized_keys_file:
				login.os === "windows"
					? "C:\\ProgramData\\ssh\\administrators_authorized_keys"
					: "~/.ssh/authorized_keys",
			sudoers,
		};
	}
}

export namespace SshLogins {
	export type Action = (typeof SshLogins.ACTIONS)[number];

	export interface Input {
		host: string | null;
		port: number;
		username: string;
		os: DeviceSettings.SshOperatingSystem;
		sudo: boolean;
	}
}
