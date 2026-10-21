import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AgentRegistry } from "../server/lib/agents/registry";
import { RuntimeMetadata } from "../server/lib/api/utils/metadata";
import { DB } from "../server/lib/db";
import { DeviceStatusService } from "../server/lib/devices/status";
import { makeAPIRequest } from "./helpers/api";
import { FakeAgent } from "./helpers/fake-agent";
import { type SeededSession, type SeededUser, seedSession, seedUser } from "./helpers/seed";

type Actor = { user: SeededUser; session: SeededSession };

async function actor(name: string): Promise<Actor> {
	const user = await seedUser("user", {
		username: `${name}_${Math.random().toString(36).slice(2, 8)}`,
	});
	return { user, session: await seedSession(user.id) };
}

let owner: Actor;
let manager: Actor;
let operator: Actor;
let viewer: Actor;
let stranger: Actor;

beforeAll(async () => {
	[owner, manager, operator, viewer, stranger] = (await Promise.all(
		["owner", "manager", "operator", "viewer", "stranger"].map(actor),
	)) as [Actor, Actor, Actor, Actor, Actor];
});

async function createAgent(token: string, kind: "esp32" | "linux" = "esp32") {
	return await makeAPIRequest<{ id: number; state: string }>("/v1/agents", {
		method: "POST",
		authToken: token,
		body: { name: `Agent ${kind}`, kind },
	});
}

async function createDevice(token: string, body: Record<string, unknown> = {}) {
	return await makeAPIRequest<{ id: number }>("/v1/devices", {
		method: "POST",
		authToken: token,
		body: { name: "PC", type: "desktop", mac_address: "aa-bb-cc-dd-ee-ff", ...body },
	});
}

describe("Agents and enrollment", () => {
	test("a new agent is unenrolled and private to its owner", async () => {
		const agent = await createAgent(owner.session.token);
		expect(agent.state).toBe("unenrolled");

		await makeAPIRequest(`/v1/agents/${agent.id}`, { authToken: stranger.session.token }, 404);
		const list = await makeAPIRequest<{ id: number }[]>("/v1/agents", {
			authToken: stranger.session.token,
		});
		expect(list.some((a) => a.id === agent.id)).toBe(false);
	});

	test("enrollment tokens are single use and the old credential is revoked on re-enrollment", async () => {
		const agent = await createAgent(owner.session.token);
		const { token } = await makeAPIRequest<{ token: string }>(`/v1/agents/${agent.id}/enrollments`, {
			method: "POST",
			authToken: owner.session.token,
		});
		const secret = "a".repeat(64);

		await makeAPIRequest("/v1/agents/enroll", {
			method: "POST",
			body: { enrollment_token: token, secret },
		});
		await makeAPIRequest(
			"/v1/agents/enroll",
			{ method: "POST", body: { enrollment_token: token, secret } },
			401,
		);

		const first = await FakeAgent.enroll(agent.id, owner.session.token);
		const firstAgent = new FakeAgent();
		await firstAgent.connect(first);
		expect(AgentRegistry.isOnline(agent.id)).toBe(true);

		const second = await FakeAgent.enroll(agent.id, owner.session.token);
		expect(firstAgent.closed?.code).toBe(4003);
		expect(await new FakeAgent().upgrade(first)).toBeInstanceOf(Response);
		expect(await new FakeAgent().upgrade(second)).toBeNull();
	});

	test("enrollment rejects weak secrets and unknown tokens", async () => {
		const agent = await createAgent(owner.session.token);
		const { token } = await makeAPIRequest<{ token: string }>(`/v1/agents/${agent.id}/enrollments`, {
			method: "POST",
			authToken: owner.session.token,
		});
		await makeAPIRequest(
			"/v1/agents/enroll",
			{ method: "POST", body: { enrollment_token: token, secret: "short" } },
			400,
		);
		await makeAPIRequest(
			"/v1/agents/enroll",
			{
				method: "POST",
				body: { enrollment_token: "netignite_enroll_nope:nope", secret: "b".repeat(64) },
			},
			401,
		);
	});

	test("the gateway rejects missing or wrong credentials before the upgrade", async () => {
		expect((await new FakeAgent().upgrade(null))?.status).toBe(401);
		expect((await new FakeAgent().upgrade("netignite_agent_abc:def"))?.status).toBe(401);
	});

	test("an agent is online only after a valid HELLO", async () => {
		const agent = await createAgent(owner.session.token);
		const credential = await FakeAgent.enroll(agent.id, owner.session.token);

		const silent = new FakeAgent();
		await silent.connect(credential, null);
		expect(AgentRegistry.isOnline(agent.id)).toBe(false);

		const wrongKind = new FakeAgent();
		await wrongKind.connect(credential, { kind: "linux" });
		expect(wrongKind.closed?.code).toBe(4001);

		const good = new FakeAgent();
		await good.connect(credential);
		expect(AgentRegistry.isOnline(agent.id)).toBe(true);
		const fetched = await makeAPIRequest<{ state: string; version: string }>(
			`/v1/agents/${agent.id}`,
			{
				authToken: owner.session.token,
			},
		);
		expect(fetched).toMatchObject({ state: "online", version: "2.0.0-test" });

		await good.disconnect();
		expect(AgentRegistry.isOnline(agent.id)).toBe(false);
	});

	test("deleting an agent disconnects it and detaches its devices", async () => {
		const agent = await createAgent(owner.session.token);
		const credential = await FakeAgent.enroll(agent.id, owner.session.token);
		const fake = new FakeAgent();
		await fake.connect(credential);
		const device = await createDevice(owner.session.token, { agent_id: agent.id });

		await makeAPIRequest(`/v1/agents/${agent.id}`, {
			method: "DELETE",
			authToken: owner.session.token,
		});
		expect(fake.closed?.code).toBe(4004);

		const fetched = await makeAPIRequest<{ agent_id: number | null }>(`/v1/devices/${device.id}`, {
			authToken: owner.session.token,
		});
		expect(fetched.agent_id).toBeNull();
	});
});

describe("Devices", () => {
	test("validates MAC addresses, status configuration and agent ownership", async () => {
		const token = owner.session.token;
		await makeAPIRequest(
			"/v1/devices",
			{
				method: "POST",
				authToken: token,
				body: { name: "x", type: "desktop", mac_address: "AABBCCDDEEFF" },
			},
			400,
		);
		await makeAPIRequest(
			"/v1/devices",
			{
				method: "POST",
				authToken: token,
				body: { name: "x", type: "toaster", mac_address: "AA:BB:CC:DD:EE:FF" },
			},
			400,
		);
		await makeAPIRequest(
			"/v1/devices",
			{
				method: "POST",
				authToken: token,
				body: {
					name: "x",
					type: "desktop",
					mac_address: "AA:BB:CC:DD:EE:FF",
					status_method: "ipv4",
					status_address: "::1",
				},
			},
			400,
		);

		const strangersAgent = await createAgent(stranger.session.token);
		await makeAPIRequest(
			"/v1/devices",
			{
				method: "POST",
				authToken: token,
				body: {
					name: "x",
					type: "desktop",
					mac_address: "AA:BB:CC:DD:EE:FF",
					agent_id: strangersAgent.id,
				},
			},
			400,
		);

		const esp = await createAgent(token, "esp32");
		await makeAPIRequest(
			"/v1/devices",
			{
				method: "POST",
				authToken: token,
				body: { name: "x", type: "desktop", mac_address: "AA:BB:CC:DD:EE:FF", host_agent_id: esp.id },
			},
			400,
		);

		const created = await createDevice(token, {
			status_method: "ipv6",
			status_address: "fe80::1%eth0",
		});
		const fetched = await makeAPIRequest<{ mac_address: string }>(`/v1/devices/${created.id}`, {
			authToken: token,
		});
		expect(fetched.mac_address).toBe("AA:BB:CC:DD:EE:FF");
	});

	test("power on sends WAKE through the device's agent and reports agent errors", async () => {
		const agent = await createAgent(owner.session.token);
		const device = await createDevice(owner.session.token, { agent_id: agent.id, wol_port: 7 });

		await makeAPIRequest(
			`/v1/devices/${device.id}/power-on`,
			{ method: "POST", authToken: owner.session.token },
			503,
		);

		const fake = new FakeAgent();
		await fake.connect(await FakeAgent.enroll(agent.id, owner.session.token));

		await makeAPIRequest(`/v1/devices/${device.id}/power-on`, {
			method: "POST",
			authToken: owner.session.token,
		});
		const wake = fake.requests.find((frame) => frame.cmd === "WAKE");
		expect(wake?.p).toEqual({ mac: "AA:BB:CC:DD:EE:FF", port: 7 });

		fake.setHandler((cmd) => {
			if (cmd === "WAKE") throw new Error("Invalid MAC address");
			return {};
		});
		await makeAPIRequest(
			`/v1/devices/${device.id}/power-on`,
			{ method: "POST", authToken: owner.session.token },
			502,
		);

		await makeAPIRequest(
			`/v1/devices/${device.id}/shutdown`,
			{ method: "POST", authToken: owner.session.token },
			409,
		);
		await fake.disconnect();
	});

	test("concurrent commands to one agent each get their own answer", async () => {
		const agent = await createAgent(owner.session.token);
		const device = await createDevice(owner.session.token, {
			agent_id: agent.id,
			status_method: "ipv4",
			status_address: "192.168.1.20",
		});

		const fake = new FakeAgent(async (cmd) => {
			if (cmd === "STATUS") {
				await Bun.sleep(300);
				return { online: true };
			}
			return {};
		});
		await fake.connect(await FakeAgent.enroll(agent.id, owner.session.token));
		DeviceStatusService.forget(device.id);

		const [status] = await Promise.all([
			makeAPIRequest<{ state: string }>(`/v1/devices/${device.id}/status`, {
				method: "POST",
				authToken: owner.session.token,
			}),
			Bun.sleep(50).then(() =>
				makeAPIRequest(`/v1/devices/${device.id}/power-on`, {
					method: "POST",
					authToken: owner.session.token,
				}),
			),
		]);
		expect(status.state).toBe("online");

		const statusRequest = fake.requests.find((frame) => frame.cmd === "STATUS");
		expect(statusRequest?.p).toEqual({ target: { type: "ip", address: "192.168.1.20" }, icmp: true });
		await fake.disconnect();
	});

	test("the SSH status method probes TCP port 22 without ICMP", async () => {
		const agent = await createAgent(owner.session.token);
		const device = await createDevice(owner.session.token, {
			agent_id: agent.id,
			status_method: "ssh",
			status_address: "nas.local",
		});
		const fake = new FakeAgent((cmd) => (cmd === "STATUS" ? { online: false } : {}));
		await fake.connect(await FakeAgent.enroll(agent.id, owner.session.token));
		DeviceStatusService.forget(device.id);

		const status = await makeAPIRequest<{ state: string }>(`/v1/devices/${device.id}/status`, {
			method: "POST",
			authToken: owner.session.token,
		});
		expect(status.state).toBe("offline");
		expect(fake.requests.find((frame) => frame.cmd === "STATUS")?.p).toEqual({
			target: { type: "host", host: "nas.local" },
			icmp: false,
			tcp_port: 22,
		});
		await fake.disconnect();
	});

	test("host agents report status and run shutdown", async () => {
		const linux = await createAgent(owner.session.token, "linux");
		const device = await createDevice(owner.session.token, {
			status_method: "host_agent",
			host_agent_id: linux.id,
		});

		const fake = new FakeAgent();
		await fake.connect(await FakeAgent.enroll(linux.id, owner.session.token), {
			kind: "linux",
			capabilities: ["host.status", "host.control"],
		});

		DeviceStatusService.forget(device.id);
		const status = await makeAPIRequest<{ state: string }>(`/v1/devices/${device.id}/status`, {
			method: "POST",
			authToken: owner.session.token,
		});
		expect(status.state).toBe("online");

		await makeAPIRequest(`/v1/devices/${device.id}/shutdown`, {
			method: "POST",
			authToken: owner.session.token,
		});
		expect(fake.requests.find((frame) => frame.cmd === "HOST_CONTROL")?.p).toEqual({
			action: "shutdown",
		});
		await fake.disconnect();
	});
});

describe("Sharing and permissions", () => {
	let deviceID: number;
	let agentID: number;
	let fake: FakeAgent;

	beforeAll(async () => {
		agentID = (await createAgent(owner.session.token)).id;
		deviceID = (await createDevice(owner.session.token, { agent_id: agentID })).id;
		fake = new FakeAgent();
		await fake.connect(await FakeAgent.enroll(agentID, owner.session.token));

		for (const [target, role] of [
			[manager, "manager"],
			[operator, "operator"],
			[viewer, "viewer"],
		] as const) {
			await makeAPIRequest(`/v1/devices/${deviceID}/shares`, {
				method: "POST",
				authToken: owner.session.token,
				body: { user: target.user.username, role },
			});
		}
	});

	test("shared devices appear in the list with the user's role", async () => {
		const devices = await makeAPIRequest<
			{ id: number; access_role: string; owner: { id: number } }[]
		>("/v1/devices", {
			authToken: operator.session.token,
		});
		const shared = devices.find((device) => device.id === deviceID);
		expect(shared).toMatchObject({
			access_role: "operator",
			owner: { id: owner.user.id },
			// Shared users can't list the owner's agents, but see which one the device uses.
			agent: { id: agentID, name: "Agent esp32", state: "online" },
		});
	});

	test("each role can do exactly what it should", async () => {
		const cases: [Actor, { read: number; power: number; edit: number; manage: number }][] = [
			[owner, { read: 200, power: 200, edit: 200, manage: 200 }],
			[manager, { read: 200, power: 200, edit: 200, manage: 403 }],
			[operator, { read: 200, power: 200, edit: 403, manage: 403 }],
			[viewer, { read: 200, power: 403, edit: 403, manage: 403 }],
			[stranger, { read: 404, power: 404, edit: 404, manage: 404 }],
		];

		for (const [who, expected] of cases) {
			const authToken = who.session.token;
			await makeAPIRequest(`/v1/devices/${deviceID}`, { authToken }, expected.read);
			await makeAPIRequest(
				`/v1/devices/${deviceID}/power-on`,
				{ method: "POST", authToken },
				expected.power,
			);
			await makeAPIRequest(
				`/v1/devices/${deviceID}`,
				{ method: "PUT", authToken, body: { description: "edited" } },
				expected.edit,
			);
			await makeAPIRequest(`/v1/devices/${deviceID}/shares`, { authToken }, expected.manage);
		}
	}, 30_000);

	test("managers can't move a device to another agent", async () => {
		await makeAPIRequest(
			`/v1/devices/${deviceID}`,
			{ method: "PUT", authToken: manager.session.token, body: { agent_id: null } },
			403,
		);
	});

	test("sharing rejects unknown users, the owner and duplicates", async () => {
		const authToken = owner.session.token;
		await makeAPIRequest(
			`/v1/devices/${deviceID}/shares`,
			{ method: "POST", authToken, body: { user: "nobody_here", role: "viewer" } },
			404,
		);
		await makeAPIRequest(
			`/v1/devices/${deviceID}/shares`,
			{ method: "POST", authToken, body: { user: owner.user.username, role: "viewer" } },
			400,
		);
		await makeAPIRequest(
			`/v1/devices/${deviceID}/shares`,
			{ method: "POST", authToken, body: { user: viewer.user.email, role: "viewer" } },
			409,
		);
	});

	test("the owner changes roles; shared users can leave and lose their favorite", async () => {
		await makeAPIRequest(`/v1/devices/${deviceID}/shares/${viewer.user.id}`, {
			method: "PUT",
			authToken: owner.session.token,
			body: { role: "operator" },
		});
		await makeAPIRequest(`/v1/devices/${deviceID}/power-on`, {
			method: "POST",
			authToken: viewer.session.token,
		});

		await makeAPIRequest(`/v1/devices/${deviceID}/favorite`, {
			method: "PUT",
			authToken: viewer.session.token,
		});
		await makeAPIRequest(`/v1/devices/${deviceID}/shares/${viewer.user.id}`, {
			method: "DELETE",
			authToken: viewer.session.token,
		});
		await makeAPIRequest(`/v1/devices/${deviceID}`, { authToken: viewer.session.token }, 404);

		const favorites = await DB.instance()
			.select()
			.from(DB.Tables.deviceFavorites)
			.where(eq(DB.Tables.deviceFavorites.user_id, viewer.user.id));
		expect(favorites).toHaveLength(0);

		await makeAPIRequest(
			`/v1/devices/${deviceID}/shares/${operator.user.id}`,
			{ method: "DELETE", authToken: manager.session.token },
			403,
		);
	});

	test("deleting a device removes its shares", async () => {
		const temp = await createDevice(owner.session.token);
		await makeAPIRequest(`/v1/devices/${temp.id}/shares`, {
			method: "POST",
			authToken: owner.session.token,
			body: { user: manager.user.username, role: "manager" },
		});
		await makeAPIRequest(
			`/v1/devices/${temp.id}`,
			{ method: "DELETE", authToken: manager.session.token },
			403,
		);
		await makeAPIRequest(`/v1/devices/${temp.id}`, {
			method: "DELETE",
			authToken: owner.session.token,
		});

		const shares = await DB.instance()
			.select()
			.from(DB.Tables.deviceShares)
			.where(eq(DB.Tables.deviceShares.device_id, temp.id));
		expect(shares).toHaveLength(0);
	});
});

describe("Registration", () => {
	test("sign-up works only while enabled", async () => {
		const body = { username: "newcomer", email: "newcomer@example.com", password: "Sup3rSecret!" };

		await RuntimeMetadata.updateSettings({ registration_enabled: false });
		expect((await makeAPIRequest<{ enabled: boolean }>("/v1/auth/registration")).enabled).toBe(false);
		await makeAPIRequest("/v1/auth/signup", { method: "POST", body }, 403);

		await RuntimeMetadata.updateSettings({ registration_enabled: true });
		const session = await makeAPIRequest<{ token: string }>(
			"/v1/auth/signup",
			{ method: "POST", body },
			201,
		);
		expect(session.token).toStartWith("netignite_sess_");
		await makeAPIRequest("/v1/auth/signup", { method: "POST", body }, 409);

		await RuntimeMetadata.updateSettings({ registration_enabled: false });
	});

	test("only admins can change server settings", async () => {
		await makeAPIRequest(
			"/v1/admin/settings",
			{ method: "PUT", authToken: owner.session.token, body: { registration_enabled: true } },
			403,
		);

		const admin = await seedUser("admin");
		const adminSession = await seedSession(admin.id);
		const settings = await makeAPIRequest<{ registration_enabled: boolean }>("/v1/admin/settings", {
			authToken: adminSession.token,
		});
		expect(settings.registration_enabled).toBe(false);
	});

	test("users imported from v1 log in with bcrypt hashes, which are upgraded", async () => {
		const bcrypt = await Bun.password.hash("V1password!", { algorithm: "bcrypt", cost: 4 });
		const user = await seedUser("user", { username: "v1_user" });
		await DB.instance()
			.update(DB.Tables.users)
			.set({ password_hash: bcrypt })
			.where(eq(DB.Tables.users.id, user.id));

		await makeAPIRequest("/v1/auth/login", {
			method: "POST",
			body: { username: "v1_user", password: "V1password!" },
		});
		const stored = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.id, user.id))
			.get();
		expect(stored?.password_hash.startsWith("$argon2id$")).toBe(true);
	});
});
