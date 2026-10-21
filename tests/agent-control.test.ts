import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConsoleRelay } from "../server/lib/agents/console";
import { LinuxInstaller } from "../server/lib/agents/linuxInstaller";
import { AgentRegistry } from "../server/lib/agents/registry";
import { API } from "../server/lib/api";
import { RuntimeMetadata } from "../server/lib/api/utils/metadata";
import { resetEnrollRateLimit } from "../server/lib/api/versions/v1/routes/agents";
import { DB } from "../server/lib/db";
import { FirmwareCatalog } from "../server/lib/firmware/catalog";
import { OtaService } from "../server/lib/firmware/ota";
import { ConfigHandler } from "../server/lib/utils/config";
import { makeAPIRequest } from "./helpers/api";
import { FakeAgent } from "./helpers/fake-agent";
import { type SeededSession, seedSession, seedUser } from "./helpers/seed";

const ESP32_CAPABILITIES = [
	"wake",
	"status.ip",
	"ota",
	"logs",
	"config",
	"device.reboot",
	"device.reset",
];

// Enrolling an agent hashes its secret (argon2); several tests enroll a few agents.
setDefaultTimeout(30_000);

let owner: SeededSession;
let stranger: SeededSession;
let firmwareDir: string;

/** A synced release with a 1 KB app image, written straight into the catalog. */
async function seedRelease(version: string, prerelease = false) {
	const app = crypto.getRandomValues(new Uint8Array(1024));
	app[0] = 0xe9;
	const dir = path.join(firmwareDir, version);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "firmware.bin"), app);

	const sha256 = createHash("sha256").update(app).digest("hex");
	await DB.instance()
		.insert(DB.Tables.firmwareReleases)
		.values({
			version,
			prerelease,
			published_at: Date.now(),
			release_url: `https://github.com/NetIgnite-project/Agent-ESP32/releases/tag/v${version}`,
			manifest: {
				format: 1,
				name: "NetIgnite Agent",
				version,
				chip_family: "ESP32",
				board: "esp32dev",
				protocol: 2,
				parts: [{ file: "firmware.bin", offset: 0x10000, size: app.length, sha256 }],
				nvs: {
					offset: 0x9000,
					size: 0x5000,
					namespace: "netignite",
					keys: ["server", "enroll", "name"],
				},
				app: { file: "firmware.bin", signature: null },
			},
			signature_verified: false,
		});
	return { app, sha256 };
}

async function createAgent(kind: "esp32" | "linux" = "esp32") {
	return await makeAPIRequest<{ id: number }>("/v1/agents", {
		method: "POST",
		authToken: owner.token,
		body: { name: `Agent ${kind}`, kind },
	});
}

/** An enrolled, connected ESP32 agent. */
async function onlineAgent(
	handler: ConstructorParameters<typeof FakeAgent>[0] = () => ({}),
	hello: Record<string, unknown> = {},
) {
	const { id } = await createAgent();
	const credential = await FakeAgent.enroll(id, owner.token);
	const agent = new FakeAgent(handler);
	await agent.connect(credential, { version: "2.0.0", capabilities: ESP32_CAPABILITIES, ...hello });
	return { id, credential, agent };
}

async function getAgent(id: number) {
	return await makeAPIRequest<{
		version: string;
		state: string;
		update: { state: string; percent: number; version: string; error: string | null } | null;
		update_available: string | null;
	}>(`/v1/agents/${id}`, { authToken: owner.token });
}

const waitUntil = async (condition: () => boolean, timeoutMs = 5000) => {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
		await Bun.sleep(20);
	}
};

beforeAll(async () => {
	OtaService.init();
	ConsoleRelay.init();

	firmwareDir = path.join(ConfigHandler.getConfig()?.FIRMWARE_DIR as string, "..", "firmware-ota");
	await FirmwareCatalog.configure({
		repo: "NetIgnite-project/Agent-ESP32",
		apiURL: "http://127.0.0.1:1",
		dir: firmwareDir,
		publicKeyPath: null,
		token: null,
	});
	await DB.instance().delete(DB.Tables.firmwareReleases);
	await seedRelease("2.1.0");
	await seedRelease("2.2.0-beta.1", true);

	owner = await seedSession((await seedUser("user")).id);
	stranger = await seedSession((await seedUser("user")).id);
});

// Every test enrolls agents; keep the enrollment rate limit (per client) out of the way.
beforeEach(() => resetEnrollRateLimit());

afterAll(async () => {
	OtaService.reset();
	ConsoleRelay.stop();
	resetEnrollRateLimit();
	await DB.instance().delete(DB.Tables.firmwareReleases);
	await RuntimeMetadata.updateSettings({ firmware_channel: "stable" });
});

describe("Firmware updates", () => {
	test("an outdated ESP32 agent is offered the recommended release and updates", async () => {
		const { id, credential, agent } = await onlineAgent();
		expect((await getAgent(id)).update_available).toBe("2.1.0");

		const started = await makeAPIRequest<{ state: string; version: string }>(
			`/v1/agents/${id}/update`,
			{ method: "POST", authToken: owner.token, body: {} },
			202,
		);
		expect(started).toMatchObject({ state: "downloading", version: "2.1.0" });

		const request = agent.requests.find((r) => r.cmd === "OTA_BEGIN");
		const release = await FirmwareCatalog.get("2.1.0");
		expect(request?.p).toEqual({
			version: "2.1.0",
			path: "/api/v1/firmware/2.1.0/files/firmware.bin",
			size: 1024,
			sha256: release?.manifest.parts[0]?.sha256,
		});

		// The agent downloads the image with its own credential.
		const download = await API.getApp().request("/v1/firmware/2.1.0/files/firmware.bin", {
			headers: { Authorization: `Bearer ${credential}` },
		});
		expect(download.status).toBe(200);
		expect(download.headers.get("content-length")).toBe("1024");

		await agent.event("OTA_PROGRESS", { version: "2.1.0", state: "downloading", percent: 40 });
		expect((await getAgent(id)).update).toMatchObject({ state: "downloading", percent: 40 });
		await agent.event("OTA_PROGRESS", { version: "2.1.0", state: "installed", percent: 100 });
		expect((await getAgent(id)).update?.state).toBe("restarting");

		// It restarts and comes back with the new version.
		await agent.disconnect();
		const restarted = new FakeAgent();
		await restarted.connect(credential, { version: "2.1.0", capabilities: ESP32_CAPABILITIES });
		const after = await getAgent(id);
		expect(after.update).toMatchObject({ state: "done", percent: 100, error: null });
		expect(after.update_available).toBeNull();

		// The prerelease channel recommends the beta.
		await makeAPIRequest("/v1/admin/settings", {
			method: "PUT",
			authToken: (await seedSession((await seedUser("admin")).id)).token,
			body: { firmware_channel: "prerelease" },
		});
		expect((await getAgent(id)).update_available).toBe("2.2.0-beta.1");
	});

	test("a rolled-back update is reported as failed", async () => {
		const { id, credential, agent } = await onlineAgent();
		await makeAPIRequest(`/v1/agents/${id}/update`, {
			method: "POST",
			authToken: owner.token,
			body: { version: "2.1.0" },
		});
		await agent.event("OTA_PROGRESS", { version: "2.1.0", state: "installed", percent: 100 });
		await agent.disconnect();

		const back = new FakeAgent();
		await back.connect(credential, {
			version: "2.0.0",
			capabilities: ESP32_CAPABILITIES,
			info: { ota_failed_version: "2.1.0" },
		});
		const update = (await getAgent(id)).update;
		expect(update?.state).toBe("failed");
		expect(update?.error).toContain("went back to 2.0.0");
	});

	test("errors reported by the agent fail the update", async () => {
		const { id, agent } = await onlineAgent();
		await makeAPIRequest(`/v1/agents/${id}/update`, {
			method: "POST",
			authToken: owner.token,
			body: { version: "2.1.0" },
		});
		await agent.event("OTA_PROGRESS", {
			version: "2.1.0",
			state: "failed",
			percent: 0,
			error: "The download doesn't match its SHA-256",
		});
		expect((await getAgent(id)).update).toMatchObject({
			state: "failed",
			error: "The download doesn't match its SHA-256",
		});
	});

	test("updates are refused when they can't work", async () => {
		const update = (id: number, body: Record<string, unknown>, code: number, token = owner.token) =>
			makeAPIRequest(`/v1/agents/${id}/update`, { method: "POST", authToken: token, body }, code);

		const offline = await createAgent();
		await update(offline.id, {}, 503);

		const linux = await createAgent("linux");
		await update(linux.id, {}, 400);

		const old = await onlineAgent(() => ({}), { capabilities: ["wake"] });
		await update(old.id, {}, 409);

		const current = await onlineAgent(() => ({}), { version: "2.1.0" });
		await update(current.id, { version: "2.1.0" }, 409);

		const refusing = await onlineAgent((cmd) => {
			if (cmd === "OTA_BEGIN") throw new Error("Not enough memory to start the update");
			return {};
		});
		await update(refusing.id, { version: "2.1.0" }, 502);
		expect((await getAgent(refusing.id)).update?.error).toContain("Not enough memory");

		const busy = await onlineAgent();
		await update(busy.id, { version: "2.1.0" }, 202);
		await update(busy.id, { version: "2.1.0" }, 409);

		await update(busy.id, { version: "9.9.9" }, 404);
		await update(busy.id, {}, 404, stranger.token);
	});

	test("only ESP32 agents may download firmware with their credential", async () => {
		const linux = await createAgent("linux");
		const credential = await FakeAgent.enroll(linux.id, owner.token);
		const fetchWith = (token: string) =>
			API.getApp().request("/v1/firmware/2.1.0/files/firmware.bin", {
				headers: { Authorization: `Bearer ${token}` },
			});

		expect((await fetchWith(credential)).status).toBe(401);
		expect((await fetchWith("netignite_agent_nope:nope")).status).toBe(401);

		// An agent credential never authenticates anything else.
		const { credential: esp } = await onlineAgent();
		expect(
			(await API.getApp().request("/v1/agents", { headers: { Authorization: `Bearer ${esp}` } }))
				.status,
		).toBe(401);
		expect(
			(await API.getApp().request("/v1/firmware", { headers: { Authorization: `Bearer ${esp}` } }))
				.status,
		).toBe(401);
	});

	test("bulk updates run one agent after another", async () => {
		const first = await onlineAgent();
		const second = await onlineAgent();
		const offline = await createAgent();

		const result = await makeAPIRequest<{
			queued: number[];
			skipped: { agent_id: number; reason: string }[];
		}>(
			"/v1/agents/bulk-update",
			{
				method: "POST",
				authToken: owner.token,
				body: { agent_ids: [first.id, second.id, offline.id, 999999], version: "2.1.0" },
			},
			202,
		);
		expect(result.queued).toEqual([first.id, second.id]);
		expect(result.skipped).toEqual([
			{ agent_id: offline.id, reason: "Offline" },
			{ agent_id: 999999, reason: "Agent not found" },
		]);

		await waitUntil(() => first.agent.requests.some((r) => r.cmd === "OTA_BEGIN"));
		expect((await getAgent(second.id)).update?.state).toBe("queued");
		expect(second.agent.requests.some((r) => r.cmd === "OTA_BEGIN")).toBe(false);

		await first.agent.event("OTA_PROGRESS", {
			version: "2.1.0",
			state: "failed",
			percent: 0,
			error: "x",
		});
		await waitUntil(() => second.agent.requests.some((r) => r.cmd === "OTA_BEGIN"), 5000);
		expect((await getAgent(second.id)).update?.state).toBe("downloading");
	});
});

describe("Agent control", () => {
	test("logs, info, settings, restart", async () => {
		const { id, agent } = await onlineAgent((cmd) => {
			if (cmd === "GET_LOGS") return { lines: ["[ 1] I booted", "[ 2] I online"], level: "info" };
			if (cmd === "GET_INFO")
				return { version: "2.0.0", info: { free_heap: 123456, ipv4: "10.0.0.9" } };
			return {};
		});

		expect(await makeAPIRequest(`/v1/agents/${id}/logs`, { authToken: owner.token })).toEqual({
			lines: ["[ 1] I booted", "[ 2] I online"],
			level: "info",
		});
		expect(await makeAPIRequest(`/v1/agents/${id}/info`, { authToken: owner.token })).toEqual({
			version: "2.0.0",
			info: { free_heap: 123456, ipv4: "10.0.0.9" },
		});

		const config = (body: Record<string, unknown>, code?: number) =>
			makeAPIRequest(
				`/v1/agents/${id}/device-config`,
				{ method: "PUT", authToken: owner.token, body },
				code,
			);
		await config({
			server_url: "https://netignite.example",
			name: "Garage-ESP32",
			log_level: "debug",
			ip: {
				mode: "static",
				address: "192.168.1.50",
				gateway: "192.168.1.1",
				netmask: "255.255.255.0",
			},
		});
		expect(agent.requests.find((r) => r.cmd === "CONFIG_SET")?.p).toEqual({
			server_url: "https://netignite.example",
			name: "Garage-ESP32",
			log_level: "debug",
			ip: {
				mode: "static",
				address: "192.168.1.50",
				gateway: "192.168.1.1",
				netmask: "255.255.255.0",
			},
		});
		await config({}, 400);
		await config({ name: "Garage ESP32" }, 400);
		await config({ server_url: "https://user:pw@example.com" }, 400);
		await config(
			{ ip: { mode: "static", address: "192.168.1.500", gateway: "1.1.1.1", netmask: "255.0.0.0" } },
			400,
		);

		await makeAPIRequest(`/v1/agents/${id}/reboot`, { method: "POST", authToken: owner.token });
		expect(agent.requests.some((r) => r.cmd === "REBOOT")).toBe(true);

		await makeAPIRequest(`/v1/agents/${id}/logs`, { authToken: stranger.token }, 404);
		await makeAPIRequest(
			`/v1/agents/${id}/reboot`,
			{ method: "POST", authToken: stranger.token },
			404,
		);
	});

	test("agent errors map to HTTP codes", async () => {
		const offline = await createAgent();
		await makeAPIRequest(`/v1/agents/${offline.id}/logs`, { authToken: owner.token }, 503);

		const old = await onlineAgent(() => ({}), { capabilities: ["wake"] });
		await makeAPIRequest(`/v1/agents/${old.id}/logs`, { authToken: owner.token }, 409);

		const failing = await onlineAgent(() => {
			throw new Error("A previous server or network change is still being tried");
		});
		await makeAPIRequest(
			`/v1/agents/${failing.id}/device-config`,
			{ method: "PUT", authToken: owner.token, body: { log_level: "info" } },
			502,
		);
	});

	test("a factory reset also revokes the credential", async () => {
		const { id, credential, agent } = await onlineAgent();
		const reset = await makeAPIRequest<{ state: string }>(`/v1/agents/${id}/factory-reset`, {
			method: "POST",
			authToken: owner.token,
		});
		expect(agent.requests.some((r) => r.cmd === "FACTORY_RESET")).toBe(true);
		expect(reset.state).toBe("unenrolled");
		expect(agent.closed?.code).toBe(4003);
		expect(await new FakeAgent().upgrade(credential)).toBeInstanceOf(Response);
	});
});

/** A browser on `/ws/console`, driven through the relay's hooks. */
class FakeViewer {
	readonly id = crypto.randomUUID();
	readonly messages: Record<string, any>[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private readonly hooks = ConsoleRelay.hooks();

	async open(origin = "http://localhost:18232") {
		const rejected = await this.hooks.upgrade!({
			headers: new Headers({ origin }),
			context: {},
		} as any);
		if (rejected instanceof Response) return rejected;
		await this.hooks.open!(this as any);
		return null;
	}

	async say(message: unknown) {
		await this.hooks.message!(this as any, { text: () => JSON.stringify(message) } as any);
	}

	async leave() {
		await this.hooks.close!(this as any, { code: 1000, reason: "test" });
	}

	send(data: string) {
		this.messages.push(JSON.parse(data));
	}

	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}
}

describe("Console", () => {
	test("streams the owner's agent log", async () => {
		let subscribed = false;
		const { id, credential, agent } = await onlineAgent((cmd, payload) => {
			if (cmd === "LOG_SUBSCRIBE") {
				subscribed = payload.enabled;
				return payload.enabled ? { lines: ["old line"], level: "info" } : {};
			}
			return {};
		});

		const viewer = new FakeViewer();
		expect(await viewer.open()).toBeNull();
		await viewer.say({ type: "auth", token: owner.token, agent_id: id });
		await waitUntil(() => viewer.messages.length >= 2);
		expect(viewer.messages).toEqual([
			{ type: "ready", online: true },
			{ type: "lines", lines: ["old line"], reset: true, level: "info" },
		]);
		expect(subscribed).toBe(true);

		await agent.event("LOG", { lines: ["new line"] });
		expect(viewer.messages.at(-1)).toEqual({ type: "lines", lines: ["new line"], reset: false });

		// The agent restarts: the viewer sees it go and come back with its stored lines.
		await agent.disconnect();
		expect(viewer.messages.at(-1)).toEqual({ type: "state", online: false });
		const back = new FakeAgent((cmd) =>
			cmd === "LOG_SUBSCRIBE" ? { lines: ["after restart"] } : {},
		);
		await back.connect(credential, { version: "2.0.0", capabilities: ESP32_CAPABILITIES });
		await waitUntil(() => viewer.messages.at(-1)?.lines?.[0] === "after restart");
		expect(viewer.messages.at(-2)).toEqual({ type: "state", online: true });

		// The last viewer leaves: the agent stops streaming.
		await viewer.leave();
		await waitUntil(() =>
			back.requests.some((r) => r.cmd === "LOG_SUBSCRIBE" && r.p?.enabled === false),
		);
	});

	test("only the owner, with a valid token, from the dashboard's origin", async () => {
		const { id } = await onlineAgent();

		const foreign = new FakeViewer();
		expect((await foreign.open("https://evil.example"))?.status).toBe(403);

		const intruder = new FakeViewer();
		await intruder.open();
		await intruder.say({ type: "auth", token: stranger.token, agent_id: id });
		expect(intruder.closed?.code).toBe(4404);

		const forged = new FakeViewer();
		await forged.open();
		await forged.say({ type: "auth", token: "netignite_sess_nope:nope", agent_id: id });
		expect(forged.closed?.code).toBe(4401);

		const confused = new FakeViewer();
		await confused.open();
		await confused.say({ hello: "there" });
		expect(confused.closed?.code).toBe(1008);
	});

	test("an offline agent can be watched until it connects", async () => {
		const { id } = await createAgent();
		const viewer = new FakeViewer();
		await viewer.open();
		await viewer.say({ type: "auth", token: owner.token, agent_id: id });
		expect(viewer.messages).toEqual([{ type: "ready", online: false }]);
		expect(AgentRegistry.isOnline(id)).toBe(false);
		await viewer.leave();
	});
});

describe("Linux agent setup", () => {
	test("an enrollment token of another agent kind is refused and stays valid", async () => {
		const linux = await createAgent("linux");
		const { token } = await makeAPIRequest<{ token: string }>(`/v1/agents/${linux.id}/enrollments`, {
			method: "POST",
			authToken: owner.token,
		});
		const secret = "c".repeat(64);

		await makeAPIRequest(
			"/v1/agents/enroll",
			{ method: "POST", body: { enrollment_token: token, secret, kind: "esp32" } },
			409,
		);
		const enrolled = await makeAPIRequest<{ agent_id: number; kind: string }>("/v1/agents/enroll", {
			method: "POST",
			body: { enrollment_token: token, secret, kind: "linux" },
		});
		expect(enrolled).toMatchObject({ agent_id: linux.id, kind: "linux" });
	});

	test("the install script is valid sh and uses the configured repository", async () => {
		const script = LinuxInstaller.script({
			serverURL: "https://netignite.example/it's",
			repo: "Example/Agent-Linux",
			version: "v1.2.3",
		});
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
		expect(script).toContain(`SERVER='https://netignite.example/it'"'"'s'`);
		expect(script).toContain("REPO='Example/Agent-Linux'");
		expect(script).toContain('VERSION="${NETIGNITE_AGENT_VERSION:-v1.2.3}"');
		expect(script).toContain("sha256sum -c");

		const sh = Bun.which("sh");
		if (sh) {
			const file = path.join(firmwareDir, "linux.sh");
			await Bun.write(file, script);
			const check = Bun.spawnSync([sh, "-n", file]);
			expect(check.exitCode).toBe(0);
		}
	});
});
