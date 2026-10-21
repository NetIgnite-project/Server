import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetEnrollRateLimit } from "../server/lib/api/versions/v1/routes/agents";
import { DB } from "../server/lib/db";
import { SshKeys } from "../server/lib/ssh/keys";
import { makeAPIRequest } from "./helpers/api";
import { FakeAgent } from "./helpers/fake-agent";
import { type SeededSession, type SeededUser, seedSession, seedUser } from "./helpers/seed";

// Enrolling an agent hashes its secret (argon2).
setDefaultTimeout(30_000);

const HOST_KEY = `SHA256:${"A".repeat(43)}`;
const OTHER_HOST_KEY = `SHA256:${"B".repeat(43)}`;

/** A real Ed25519 public key as an agent reports it: `ssh-ed25519 <base64 blob>`. */
function publicKey() {
	const { publicKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
	const field = (data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		return Buffer.concat([length, data]);
	};
	const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
	return `ssh-ed25519 ${blob.toString("base64")}`;
}

let admin: SeededSession;
let owner: SeededSession;
let managerUser: SeededUser;
let manager: SeededSession;
let stranger: SeededSession;

async function setSsh(enabled: boolean) {
	await makeAPIRequest("/v1/admin/settings", {
		method: "PUT",
		authToken: admin.token,
		body: { ssh_enabled: enabled },
	});
}

beforeAll(async () => {
	admin = await seedSession((await seedUser("admin")).id);
	owner = await seedSession((await seedUser("user")).id);
	managerUser = await seedUser("user");
	manager = await seedSession(managerUser.id);
	stranger = await seedSession((await seedUser("user")).id);
	await setSsh(true);
});
beforeEach(() => resetEnrollRateLimit());
afterAll(() => resetEnrollRateLimit());

/** A device behind a Linux agent in Wake-on-LAN mode, which logs in over SSH with its own keys. */
async function setup(
	handler: ConstructorParameters<typeof FakeAgent>[0],
	options: { capabilities?: string[]; sshKeys?: Record<string, unknown> | null } = {},
) {
	const keys = { shutdown: publicKey(), reboot: publicKey() };
	const agent = await makeAPIRequest<{ id: number }>("/v1/agents", {
		method: "POST",
		authToken: owner.token,
		body: { name: "Network agent", kind: "linux" },
	});
	const credential = await FakeAgent.enroll(agent.id, owner.token);
	const fake = new FakeAgent(handler);
	await fake.connect(credential, {
		kind: "linux",
		capabilities: options.capabilities ?? ["wake", "status.tcp", "ssh.power"],
		...(options.sshKeys === null ? {} : { ssh_keys: options.sshKeys ?? keys }),
	});

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
	return { agentID: agent.id, device, fake, keys };
}

type SshInfo = {
	enabled: boolean;
	configured: boolean;
	effective_host: string | null;
	username: string | null;
	host_key: string | null;
	authorized_keys: string | null;
	authorized_keys_file: string | null;
	sudoers: string | null;
	agent_keys: boolean;
	agent_ready: boolean;
};

const saveLogin = (deviceID: number, body: Record<string, unknown> = { username: "netignite" }) =>
	makeAPIRequest<SshInfo>(`/v1/devices/${deviceID}/ssh`, {
		method: "PUT",
		authToken: owner.token,
		body,
	});

describe("SSH public keys", () => {
	test("accepts Ed25519 public keys and computes OpenSSH's fingerprint", () => {
		const key = publicKey();
		expect(SshKeys.isPublicKey(key)).toBe(true);
		expect(SshKeys.isFingerprint(SshKeys.fingerprint(key))).toBe(true);

		expect(SshKeys.isPublicKey(`${key} comment`)).toBe(false);
		expect(SshKeys.isPublicKey(key.replace("ssh-ed25519", "ssh-rsa"))).toBe(false);
		// Right length and characters, but not an Ed25519 blob.
		expect(SshKeys.isPublicKey(`ssh-ed25519 ${"A".repeat(68)}`)).toBe(false);

		const keygen = Bun.which("ssh-keygen");
		if (keygen) {
			const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "netignite-key-")), "key.pub");
			fs.writeFileSync(file, `${key}\n`);
			const listed = Bun.spawnSync([keygen, "-lf", file]).stdout.toString();
			expect(listed).toContain(SshKeys.fingerprint(key));
		}
	});
});

describe("SSH login", () => {
	test("the agent's keys from HELLO become one forced-command line each", async () => {
		const { agentID, device, keys } = await setup(() => ({}));
		const saved = await saveLogin(device.id, { username: "netignite" });
		expect(saved).toMatchObject({
			enabled: true,
			configured: true,
			effective_host: "192.168.1.20",
			username: "netignite",
			host_key: null,
			agent_keys: true,
			agent_ready: true,
			authorized_keys_file: "~/.ssh/authorized_keys",
		});
		expect(saved.authorized_keys).toBe(
			[
				`restrict,command="sudo -n shutdown -h now" ${keys.shutdown} netignite-agent-${agentID}-shutdown`,
				`restrict,command="sudo -n shutdown -r now" ${keys.reboot} netignite-agent-${agentID}-reboot`,
			].join("\n"),
		);
		expect(saved.sudoers).toBe(
			"netignite ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now, /usr/sbin/shutdown -r now, /sbin/shutdown -h now, /sbin/shutdown -r now",
		);

		// root needs no sudo; Windows gets its own commands and file.
		const root = await saveLogin(device.id, { username: "root" });
		expect(root.authorized_keys).toContain('restrict,command="shutdown -h now" ');
		expect(root.sudoers).toBeNull();
		const windows = await saveLogin(device.id, { username: "netignite", os: "windows" });
		expect(windows.authorized_keys?.split("\n")).toEqual([
			`restrict,command="shutdown /s /t 0" ${keys.shutdown} netignite-agent-${agentID}-shutdown`,
			`restrict,command="shutdown /r /t 0" ${keys.reboot} netignite-agent-${agentID}-reboot`,
		]);
		expect(windows.authorized_keys_file).toBe("C:\\ProgramData\\ssh\\administrators_authorized_keys");
		expect(windows.sudoers).toBeNull();

		// The server stores no secret at all.
		const row = await DB.instance()
			.select()
			.from(DB.Tables.deviceSshLogins)
			.where(eq(DB.Tables.deviceSshLogins.device_id, device.id))
			.get();
		expect(Object.keys(row ?? {}).sort()).toEqual(
			["created_at", "device_id", "host", "host_key", "os", "port", "sudo", "username"].sort(),
		);
	});

	test("without keys from the agent there are no lines; invalid keys don't break HELLO", async () => {
		const missing = await setup(() => ({}), { sshKeys: null });
		const saved = await saveLogin(missing.device.id);
		expect(saved).toMatchObject({ agent_keys: false, authorized_keys: null });

		const invalid = await setup(() => ({}), { sshKeys: { shutdown: "ssh-rsa AAAA", reboot: 7 } });
		expect(invalid.fake.closed).toBeNull();
		expect((await saveLogin(invalid.device.id)).agent_keys).toBe(false);
	});

	test("only the owner manages the login", async () => {
		const { device } = await setup(() => ({}));
		const body = { username: "netignite" };
		const url = `/v1/devices/${device.id}/ssh`;
		await makeAPIRequest(url, { method: "PUT", authToken: manager.token, body }, 403);
		await makeAPIRequest(url, { authToken: manager.token }, 403);
		await makeAPIRequest(url, { method: "PUT", authToken: stranger.token, body }, 404);
		await makeAPIRequest(`${url}/test`, { method: "POST", authToken: manager.token }, 403);
		await makeAPIRequest(
			`${url}/trust`,
			{ method: "POST", authToken: manager.token, body: { host_key: HOST_KEY } },
			403,
		);
	});

	test("invalid input is rejected", async () => {
		const { device } = await setup(() => ({}));
		const put = (body: Record<string, unknown>) =>
			makeAPIRequest(
				`/v1/devices/${device.id}/ssh`,
				{ method: "PUT", authToken: owner.token, body },
				400,
			);
		await put({ username: "a b" });
		await put({ username: "netignite", port: 70000 });
		await put({ username: "netignite", host: "not a host!" });
		await put({ username: "netignite", os: "plan9" });
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/trust`,
			{ method: "POST", authToken: owner.token, body: { host_key: "MD5:aa:bb" } },
			400,
		);
	});

	test("test, trust, then shutdown and reboot with SSH_POWER: no credentials leave the server", async () => {
		const requests: { cmd: string; p: Record<string, unknown> }[] = [];
		const { device } = await setup((cmd, payload) => {
			requests.push({ cmd, p: payload });
			if (cmd === "SSH_CHECK")
				return { online: true, host_key: HOST_KEY, shutdown: true, reboot: true };
			return {};
		});
		await saveLogin(device.id, { username: "netignite" });

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
			shutdown: boolean;
			reboot: boolean;
		}>(`/v1/devices/${device.id}/ssh/test`, { method: "POST", authToken: owner.token });
		expect(result).toMatchObject({
			host_key: HOST_KEY,
			trusted: false,
			shutdown: true,
			reboot: true,
		});
		expect(requests.at(-1)).toEqual({
			cmd: "SSH_CHECK",
			p: { host: "192.168.1.20", port: 22, username: "netignite", host_key: null },
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
			cmd: "SSH_POWER",
			p: {
				host: "192.168.1.20",
				port: 22,
				username: "netignite",
				host_key: HOST_KEY,
				action: "reboot",
				os: "posix",
				sudo: true,
			},
		});

		// Changing the host un-trusts the key.
		const moved = await saveLogin(device.id, { username: "netignite", host: "192.168.1.21" });
		expect(moved.host_key).toBeNull();
		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.token },
			409,
		);
	});

	test("a changed host key and refused keys are reported, and agent errors reach the user", async () => {
		const { device, fake } = await setup((cmd) =>
			cmd === "SSH_CHECK"
				? { online: true, host_key: OTHER_HOST_KEY, error: "host_key_mismatch" }
				: {},
		);
		await saveLogin(device.id);
		await makeAPIRequest(`/v1/devices/${device.id}/ssh/trust`, {
			method: "POST",
			authToken: owner.token,
			body: { host_key: HOST_KEY },
		});

		const testLogin = () =>
			makeAPIRequest<Record<string, unknown>>(`/v1/devices/${device.id}/ssh/test`, {
				method: "POST",
				authToken: owner.token,
			});
		expect(await testLogin()).toMatchObject({
			trusted: false,
			error: "host_key_mismatch",
			host_key: OTHER_HOST_KEY,
			shutdown: false,
			reboot: false,
		});

		fake.setHandler((cmd) =>
			cmd === "SSH_CHECK" ? { online: true, host_key: HOST_KEY, shutdown: true, reboot: false } : {},
		);
		expect(await testLogin()).toMatchObject({
			trusted: true,
			shutdown: true,
			reboot: false,
			error: null,
		});

		fake.setHandler((cmd) => {
			if (cmd === "SSH_POWER") throw new Error("sudo: a password is required");
			return {};
		});
		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.token },
			502,
		);
	});

	test("agents without ssh.power (beta firmware with `ssh`) are never asked", async () => {
		const { device, fake } = await setup(() => ({}), { capabilities: ["wake", "status.tcp", "ssh"] });
		const saved = await saveLogin(device.id);
		expect(saved.agent_ready).toBe(false);
		await makeAPIRequest(
			`/v1/devices/${device.id}/ssh/test`,
			{ method: "POST", authToken: owner.token },
			503,
		);
		expect(fake.requests.filter((request) => request.cmd?.startsWith("SSH"))).toEqual([]);
	});

	test("with SSH turned off nothing goes over SSH, even with a trusted login", async () => {
		const requests: string[] = [];
		const { device } = await setup((cmd) => {
			requests.push(cmd);
			return {};
		});
		await saveLogin(device.id);
		await makeAPIRequest(`/v1/devices/${device.id}/ssh/trust`, {
			method: "POST",
			authToken: owner.token,
			body: { host_key: HOST_KEY },
		});

		await setSsh(false);
		try {
			const url = `/v1/devices/${device.id}`;
			const info = await makeAPIRequest<SshInfo>(`${url}/ssh`, { authToken: owner.token });
			expect(info.enabled).toBe(false);
			await makeAPIRequest(
				`${url}/ssh`,
				{ method: "PUT", authToken: owner.token, body: { username: "x" } },
				409,
			);
			await makeAPIRequest(`${url}/ssh/test`, { method: "POST", authToken: owner.token }, 409);
			await makeAPIRequest(
				`${url}/ssh/trust`,
				{ method: "POST", authToken: owner.token, body: { host_key: HOST_KEY } },
				409,
			);
			const listed = await makeAPIRequest<{ actions: { shutdown: boolean } }>(url, {
				authToken: owner.token,
			});
			expect(listed.actions.shutdown).toBe(false);
			await makeAPIRequest(`${url}/shutdown`, { method: "POST", authToken: owner.token }, 409);
			expect(requests.filter((cmd) => cmd.startsWith("SSH"))).toEqual([]);
		} finally {
			await setSsh(true);
		}
	});

	test("SSH is off on a new server", async () => {
		await DB.instance().delete(DB.Tables.metadata).where(eq(DB.Tables.metadata.key, "settings"));
		try {
			const fresh = await makeAPIRequest<{ ssh_enabled: boolean }>("/v1/admin/settings", {
				authToken: admin.token,
			});
			expect(fresh.ssh_enabled).toBe(false);
		} finally {
			await setSsh(true);
		}
	});

	test("removing the login and deleting the device remove it", async () => {
		const { device } = await setup(() => ({}));
		const rows = () =>
			DB.instance()
				.select()
				.from(DB.Tables.deviceSshLogins)
				.where(eq(DB.Tables.deviceSshLogins.device_id, device.id))
				.all();

		await saveLogin(device.id);
		await makeAPIRequest(`/v1/devices/${device.id}/ssh`, {
			method: "DELETE",
			authToken: owner.token,
		});
		expect(rows()).toHaveLength(0);
		const info = await makeAPIRequest<SshInfo>(`/v1/devices/${device.id}/ssh`, {
			authToken: owner.token,
		});
		expect(info.configured).toBe(false);

		await saveLogin(device.id);
		await makeAPIRequest(`/v1/devices/${device.id}`, { method: "DELETE", authToken: owner.token });
		expect(rows()).toHaveLength(0);
	});
});
