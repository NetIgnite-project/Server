import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetEnrollRateLimit } from "../server/lib/api/versions/v1/routes/agents";
import { DB } from "../server/lib/db";
import { SshKeys } from "../server/lib/ssh/keys";
import { Secrets } from "../server/lib/utils/secrets";
import { makeAPIRequest } from "./helpers/api";
import { FakeAgent } from "./helpers/fake-agent";
import { type SeededSession, type SeededUser, seedSession, seedUser } from "./helpers/seed";

// Enrolling an agent hashes its secret (argon2).
setDefaultTimeout(30_000);

const HOST_KEY = `SHA256:${"A".repeat(43)}`;
const OTHER_HOST_KEY = `SHA256:${"B".repeat(43)}`;

let owner: SeededSession;
let managerUser: SeededUser;
let manager: SeededSession;
let stranger: SeededSession;

beforeAll(async () => {
	owner = await seedSession((await seedUser("user")).id);
	managerUser = await seedUser("user");
	manager = await seedSession(managerUser.id);
	stranger = await seedSession((await seedUser("user")).id);
});
beforeEach(() => resetEnrollRateLimit());
afterAll(() => resetEnrollRateLimit());

/** A device behind a Linux agent in Wake-on-LAN mode (which logs in over SSH). */
async function setup(
	handler: ConstructorParameters<typeof FakeAgent>[0],
	capabilities = ["wake", "status.tcp", "ssh"],
) {
	const agent = await makeAPIRequest<{ id: number }>("/v1/agents", {
		method: "POST",
		authToken: owner.token,
		body: { name: "Network agent", kind: "linux" },
	});
	const credential = await FakeAgent.enroll(agent.id, owner.token);
	const fake = new FakeAgent(handler);
	await fake.connect(credential, { kind: "linux", capabilities });

	const device = await makeAPIRequest<{ id: number }>("/v1/devices", {
		method: "POST",
		authToken: owner.token,
		body: {
			name: "NAS",
			type: "nas",
			mac_address: "aa:bb:cc:dd:ee:01",
			agent_id: agent.id,
			status_method: "ssh",
			status_address: "192.168.1.20",
		},
	});
	await makeAPIRequest(`/v1/devices/${device.id}/shares`, {
		method: "POST",
		authToken: owner.token,
		body: { user: managerUser.username, role: "manager" },
	});
	return { device, fake };
}

type SshInfo = {
	configured: boolean;
	effective_host: string | null;
	username: string | null;
	auth_type: string | null;
	public_key: string | null;
	host_key: string | null;
	authorized_keys: string | null;
	sudoers: string | null;
	agent_ready: boolean;
};

describe("SSH keys and secrets", () => {
	test("generated keys are valid OpenSSH Ed25519 keys", async () => {
		const key = SshKeys.generateEd25519("netignite-device-1");
		expect(key.privateKey).toStartWith("-----BEGIN OPENSSH PRIVATE KEY-----\n");
		expect(key.publicKey).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* netignite-device-1$/,
		);
		expect(SshKeys.isFingerprint(key.fingerprint)).toBe(true);

		// ssh-keygen derives the same public key from the private key.
		const keygen = Bun.which("ssh-keygen");
		if (keygen) {
			const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "netignite-key-")), "id_ed25519");
			fs.writeFileSync(file, key.privateKey, { mode: 0o600 });
			const derived = Bun.spawnSync([keygen, "-y", "-f", file]);
			expect(derived.stdout.toString().trim()).toBe(key.publicKey);
		}
	});

	test("secrets are encrypted with the server's key", () => {
		const encrypted = Secrets.encrypt("hunter2");
		expect(encrypted).not.toContain("hunter2");
		expect(Secrets.decrypt(encrypted)).toBe("hunter2");
		expect(Secrets.encrypt("hunter2")).not.toBe(encrypted);
	});
});

describe("SSH login", () => {
	test("a password login is stored encrypted and never returned", async () => {
		const { device } = await setup(() => ({}));
		const saved = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "admin", auth: { type: "password", password: "s3cret-pw" } },
		});
		expect(saved).toMatchObject({
			configured: true,
			effective_host: "192.168.1.20",
			username: "admin",
			auth_type: "password",
			public_key: null,
			host_key: null,
			agent_ready: true,
		});
		expect(saved.sudoers).toContain("admin ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now");
		expect(JSON.stringify(saved)).not.toContain("s3cret-pw");

		const row = await DB.instance()
			.select()
			.from(DB.Tables.deviceSshCredentials)
			.where(eq(DB.Tables.deviceSshCredentials.device_id, device.id))
			.get();
		expect(row?.secret_encrypted).not.toContain("s3cret-pw");
	});

	test("a generated key gives an authorized_keys line", async () => {
		const { device } = await setup(() => ({}));
		const saved = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "root", host: "nas.local", auth: { type: "generate_key" } },
		});
		expect(saved.auth_type).toBe("key");
		expect(saved.effective_host).toBe("nas.local");
		expect(saved.authorized_keys).toBe(`restrict ${saved.public_key}`);
		expect(saved.sudoers).toBeNull(); // root needs no sudo
		expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");

		// "keep" keeps the key.
		const kept = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "root", host: "nas.local", port: 2222, auth: { type: "keep" } },
		});
		expect(kept.public_key).toBe(saved.public_key);
	});

	test("only the owner manages the login", async () => {
		const { device } = await setup(() => ({}));
		const body = { username: "admin", auth: { type: "password", password: "pw" } };
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh`,
			{ method: "PUT", authToken: manager.token, body },
			403,
		);
		await makeAPIRequest(`/v1/devices/${device.id}/ssh`, { authToken: manager.token }, 403);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh`,
			{ method: "PUT", authToken: stranger.token, body },
			404,
		);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/test`,
			{ method: "POST", authToken: manager.token },
			403,
		);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/trust`,
			{ method: "POST", authToken: manager.token, body: { host_key: HOST_KEY } },
			403,
		);
	});

	test("invalid input is rejected", async () => {
		const { device } = await setup(() => ({}));
		const put = (body: Record<string, unknown>, code: number) =>
			makeAPIRequest(
				`/v1/devices/${device.id}/ssh`,
				{ method: "PUT", authToken: owner.token, body },
				code,
			);
		await put({ username: "admin", auth: { type: "keep" } }, 400); // nothing stored to keep
		await put({ username: "a b", auth: { type: "generate_key" } }, 400);
		await put({ username: "admin", port: 70000, auth: { type: "generate_key" } }, 400);
		await put({ username: "admin", host: "not a host!", auth: { type: "generate_key" } }, 400);
		await put({ username: "admin", auth: { type: "magic" } }, 400);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/trust`,
			{ method: "POST", authToken: owner.token, body: { host_key: "MD5:aa:bb" } },
			400,
		);
	});

	test("test, trust, then shutdown and reboot over SSH", async () => {
		const requests: { cmd: string; p: Record<string, any> }[] = [];
		const { device } = await setup((cmd, payload) => {
			requests.push({ cmd, p: payload });
			if (cmd === "SSH_CHECK") {
				return payload.host_key && payload.host_key !== HOST_KEY
					? { online: true, host_key: HOST_KEY, authenticated: false, error: "host_key_mismatch" }
					: { online: true, host_key: HOST_KEY, authenticated: true };
			}
			return {};
		});
		await makeAPIRequest(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "admin", auth: { type: "password", password: "pw" } },
		});

		// Not trusted yet: no shutdown.
		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.token },
			409,
		);
		let listed = await makeAPIRequest<{ actions: { shutdown: boolean } }>(
			`/v1/devices/${device.id}`,
			{
				authToken: owner.token,
			},
		);
		expect(listed.actions.shutdown).toBe(false);

		const result = await makeAPIRequest<{
			host_key: string;
			trusted: boolean;
			authenticated: boolean;
		}>(`/v1/devices/${device.id}/ssh/test`, { method: "POST", authToken: owner.token });
		expect(result).toMatchObject({ host_key: HOST_KEY, trusted: false, authenticated: true });
		expect(requests.at(-1)).toEqual({
			cmd: "SSH_CHECK",
			p: {
				host: "192.168.1.20",
				port: 22,
				username: "admin",
				auth: { type: "password", password: "pw" },
				host_key: null,
			},
		});

		await makeAPIRequest(`/v1/devices/${device.id}/ssh/trust`, {
			method: "POST",
			authToken: owner.token,
			body: { host_key: result.host_key },
		});
		listed = await makeAPIRequest(`/v1/devices/${device.id}`, { authToken: owner.token });
		expect(listed.actions.shutdown).toBe(true);

		// A manager may power the device down; the agent gets the trusted key and the fixed action.
		await makeAPIRequest(`/v1/devices/${device.id}/reboot`, {
			method: "POST",
			authToken: manager.token,
		});
		expect(requests.at(-1)).toEqual({
			cmd: "SSH_EXEC",
			p: {
				host: "192.168.1.20",
				port: 22,
				username: "admin",
				auth: { type: "password", password: "pw" },
				host_key: HOST_KEY,
				action: "reboot",
				os: "posix",
				sudo: true,
			},
		});

		// Changing the host un-trusts the key.
		const moved = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "admin", host: "192.168.1.21", auth: { type: "keep" } },
		});
		expect(moved.host_key).toBeNull();
		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.token },
			409,
		);
	});

	test("a changed host key is reported, and agent errors reach the user", async () => {
		const { device } = await setup((cmd, payload) => {
			if (cmd === "SSH_CHECK") {
				return {
					online: true,
					host_key: OTHER_HOST_KEY,
					authenticated: false,
					error: "host_key_mismatch",
				};
			}
			if (cmd === "SSH_EXEC" && payload.action === "shutdown")
				throw new Error("sudo: a password is required");
			return {};
		});
		await makeAPIRequest(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "admin", auth: { type: "password", password: "pw" } },
		});
		await makeAPIRequest(`/v1/devices/${device.id}/ssh/trust`, {
			method: "POST",
			authToken: owner.token,
			body: { host_key: HOST_KEY },
		});

		const result = await makeAPIRequest<{ trusted: boolean; error: string; host_key: string }>(
			`/v1/devices/${device.id}/ssh/test`,
			{ method: "POST", authToken: owner.token },
		);
		expect(result).toMatchObject({
			trusted: false,
			error: "host_key_mismatch",
			host_key: OTHER_HOST_KEY,
		});

		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.token },
			502,
		);
	});

	test("an agent without SSH can't test or use the login", async () => {
		const { device } = await setup(() => ({}), ["wake", "status.tcp"]);
		const saved = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			method: "PUT",
			authToken: owner.token,
			body: { username: "admin", auth: { type: "password", password: "pw" } },
		});
		expect(saved.agent_ready).toBe(false);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/test`,
			{ method: "POST", authToken: owner.token },
			503,
		);
	});

	test("removing the login and deleting the device remove the secret", async () => {
		const { device } = await setup(() => ({}));
		const put = () =>
			makeAPIRequest(`/v1/devices/${device.id}/ssh`, {
				method: "PUT",
				authToken: owner.token,
				body: { username: "admin", auth: { type: "generate_key" } },
			});
		const rows = () =>
			DB.instance()
				.select()
				.from(DB.Tables.deviceSshCredentials)
				.where(eq(DB.Tables.deviceSshCredentials.device_id, device.id))
				.all();

		await put();
		await makeAPIRequest(`/v1/devices/${device.id}/ssh`, {
			method: "DELETE",
			authToken: owner.token,
		});
		expect(rows()).toHaveLength(0);
		expect(
			(await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, { authToken: owner.token }))
				.configured,
		).toBe(false);

		await put();
		await makeAPIRequest(`/v1/devices/${device.id}`, { method: "DELETE", authToken: owner.token });
		expect(rows()).toHaveLength(0);
	});
});
