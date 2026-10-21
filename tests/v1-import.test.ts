import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { RuntimeMetadata } from "../server/lib/api/utils/metadata";
import { DB } from "../server/lib/db";
import { V1Importer } from "../server/lib/migration/v1Import";
import { makeAPIRequest } from "./helpers/api";
import { seedSession, seedUser } from "./helpers/seed";

// Table definitions exactly as NetIgnite v1 (Server 0.1.x) creates them.
const V1_SCHEMA = `
CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
	favorites TEXT NOT NULL DEFAULT ''
);
CREATE TABLE agents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	type TEXT NOT NULL CHECK(type IN ('server', 'microcontroller')),
	description TEXT NOT NULL,
	secret TEXT NOT NULL,
	ownerID INTEGER NOT NULL
);
CREATE TABLE devices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	type TEXT NOT NULL CHECK(type IN ('server', 'desktop', 'laptop', 'printer', 'nas')),
	description TEXT,
	macAddress TEXT NOT NULL,
	port INTEGER NOT NULL,
	agentID INTEGER NOT NULL,
	ownerID INTEGER NOT NULL
);
`;

let dir: string;
let v1Path: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "netignite-v1-"));
	v1Path = join(dir, "db.sqlite");

	const v1 = new Database(v1Path);
	v1.exec(V1_SCHEMA);
	const hash = (password: string) =>
		Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 4 });

	v1.run(
		"INSERT INTO users (id, username, password_hash, role, favorites) VALUES (1, 'v1alice', ?, 'admin', '[1, 99]')",
		[hash("alice-pass")],
	);
	v1.run(
		"INSERT INTO users (id, username, password_hash, role, favorites) VALUES (2, 'v1bobby', ?, 'user', '')",
		[hash("bob-pass")],
	);
	v1.run(
		"INSERT INTO agents (id, name, type, description, secret, ownerID) VALUES (1, 'Office ESP', 'microcontroller', 'desk', 'sha256:x', 1)",
	);
	v1.run(
		"INSERT INTO agents (id, name, type, description, secret, ownerID) VALUES (2, 'Bob server', 'server', '', 'plain', 2)",
	);
	v1.run(
		"INSERT INTO devices VALUES (1, 'Gaming PC', 'desktop', NULL, 'aa-bb-cc-dd-ee-01', 9, 1, 1)",
	);
	v1.run("INSERT INTO devices VALUES (2, 'Broken MAC', 'server', '', 'AABBCCDDEE02', 9, 1, 1)");
	// v1 allowed binding a device to another user's agent; the import drops that link.
	v1.run("INSERT INTO devices VALUES (3, 'Bob NAS', 'nas', 'rack', 'AA:BB:CC:DD:EE:03', 7, 1, 2)");
	v1.close();
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("v1 import", () => {
	test("a v1 database next to the v2 one is reported until something is imported", async () => {
		expect(await V1Importer.pendingV1Database(join(dir, "netignite.sqlite"))).toBe(v1Path);
		expect(await V1Importer.pendingV1Database(join(dir, "elsewhere", "netignite.sqlite"))).toBeNull();
	});

	test("a dry run changes nothing", async () => {
		const report = await V1Importer.run({ sourcePath: v1Path, dryRun: true });
		expect(report.users.imported).toEqual(["v1alice", "v1bobby"]);

		const alice = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.username, "v1alice"))
			.get();
		expect(alice).toBeUndefined();
	});

	test("imports users, agents, devices and favorites", async () => {
		const report = await V1Importer.run({ sourcePath: v1Path });

		expect(report.users.imported).toEqual(["v1alice", "v1bobby"]);
		expect(report.agents.imported).toBe(2);
		expect(report.devices.imported).toBe(2);
		expect(report.devices.skipped).toEqual([
			{ name: "Broken MAC", reason: 'invalid MAC address "AABBCCDDEE02"' },
		]);
		expect(report.favorites).toBe(1);

		const alice = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.username, "v1alice"))
			.get();
		expect(alice).toMatchObject({
			role: "admin",
			email: `v1alice@${V1Importer.PLACEHOLDER_EMAIL_DOMAIN}`,
		});

		const agents = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.owner_id, alice!.id));
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({ kind: "esp32", token_id: null, name: "Office ESP" });

		const pc = await DB.instance()
			.select()
			.from(DB.Tables.devices)
			.where(eq(DB.Tables.devices.name, "Gaming PC"))
			.get();
		expect(pc).toMatchObject({
			mac_address: "AA:BB:CC:DD:EE:01",
			agent_id: agents[0]!.id,
			status_method: "link_local",
		});

		const nas = await DB.instance()
			.select()
			.from(DB.Tables.devices)
			.where(eq(DB.Tables.devices.name, "Bob NAS"))
			.get();
		expect(nas).toMatchObject({ agent_id: null, status_method: "link_local", wol_port: 7 });
	});

	test("an imported v1 database isn't reported anymore", async () => {
		expect(await V1Importer.pendingV1Database(join(dir, "netignite.sqlite"))).toBeNull();
	});

	test("running it again imports nothing twice", async () => {
		const report = await V1Importer.run({ sourcePath: v1Path });
		expect(report.users.imported).toEqual([]);
		expect(report.agents.imported).toBe(0);
		expect(report.devices.imported).toBe(0);
		expect(report.favorites).toBe(0);
	});

	test("imported users log in with their v1 password", async () => {
		const session = await makeAPIRequest<{ token: string }>("/v1/auth/login", {
			method: "POST",
			body: { username: "v1bobby", password: "bob-pass" },
		});
		expect(session.token).toStartWith("netignite_sess_");
	});

	test("rejects files that aren't v1 databases", async () => {
		const other = join(dir, "other.sqlite");
		const db = new Database(other);
		db.exec("CREATE TABLE foo (id INTEGER)");
		db.close();
		await expect(V1Importer.run({ sourcePath: other })).rejects.toThrow(
			"Not a NetIgnite v1 database",
		);
	});
});

describe("v1 import: merging users", () => {
	let mergeDir: string;
	let mergePath: string;

	beforeAll(async () => {
		// A second v1 database: start from a clean import state, as a server only ever imports one.
		await DB.instance().delete(DB.Tables.metadata).where(eq(DB.Tables.metadata.key, "v1_import"));

		mergeDir = mkdtempSync(join(tmpdir(), "netignite-v1-merge-"));
		mergePath = join(mergeDir, "db.sqlite");
		const v1 = new Database(mergePath);
		v1.exec(V1_SCHEMA);
		const hash = (password: string) =>
			Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 4 });
		v1.run("INSERT INTO users VALUES (1, 'admin', ?, 'admin', '')", [hash("admin-from-v1")]);
		v1.run("INSERT INTO users VALUES (2, 'collide', ?, 'user', '')", [hash("collide-from-v1")]);
		v1.run("INSERT INTO agents VALUES (1, 'Admin ESP', 'microcontroller', '', 's', 1)");
		v1.run("INSERT INTO agents VALUES (2, 'Collide ESP', 'microcontroller', '', 's', 2)");
		v1.close();

		// A v2 user with the same name who already logged in.
		const collide = await seedUser("user", { username: "collide" }, "collide-in-v2");
		await seedSession(collide.id);
	});

	afterAll(() => {
		rmSync(mergeDir, { recursive: true, force: true });
	});

	test("v1 admin is merged into the initial admin; other name clashes need --merge-users", async () => {
		const initialAdmin = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.username, "admin"))
			.get();
		// Nobody has set the initial admin's password while its reset link is unused.
		const adminPasswordUnset = !!(await DB.instance()
			.select()
			.from(DB.Tables.passwordResets)
			.where(eq(DB.Tables.passwordResets.user_id, initialAdmin!.id))
			.get());

		const report = await V1Importer.run({ sourcePath: mergePath });
		expect(report.users.merged).toEqual(["admin"]);
		expect(report.users.skipped).toEqual([
			{
				username: "collide",
				reason: "username already exists in v2 (use --merge-users to merge them)",
			},
		]);
		expect(report.agents.imported).toBe(1);

		const adminAgents = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.owner_id, initialAdmin!.id));
		expect(adminAgents.map((agent) => agent.name)).toContain("Admin ESP");

		// The v1 password is only taken over by the initial admin whose password nobody has set yet.
		expect(adminPasswordUnset).toBe(true);
		await makeAPIRequest("/v1/auth/login", {
			method: "POST",
			body: { username: "admin", password: "admin-from-v1" },
		});
	});

	test("--merge-users merges the clash but keeps the password of a used v2 account", async () => {
		const report = await V1Importer.run({ sourcePath: mergePath, mergeUsers: true });
		expect(report.users.merged).toEqual(["collide"]);
		expect(report.agents.imported).toBe(1);

		await makeAPIRequest("/v1/auth/login", {
			method: "POST",
			body: { username: "collide", password: "collide-in-v2" },
		});
		await makeAPIRequest(
			"/v1/auth/login",
			{ method: "POST", body: { username: "collide", password: "collide-from-v1" } },
			401,
		);
	});

	test("an admin who set a password in v2 keeps it, even without a session", async () => {
		const admin = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.username, "admin"))
			.get();
		await DB.instance()
			.update(DB.Tables.users)
			.set({ password_hash: await Bun.password.hash("set-in-v2-Passw0rd!") })
			.where(eq(DB.Tables.users.id, admin!.id));
		await DB.instance().delete(DB.Tables.sessions).where(eq(DB.Tables.sessions.user_id, admin!.id));
		await RuntimeMetadata.setV1ImportState({ users: {}, agents: {}, devices: {} });

		const report = await V1Importer.run({ sourcePath: mergePath });
		expect(report.users.merged).toContain("admin");
		await makeAPIRequest("/v1/auth/login", {
			method: "POST",
			body: { username: "admin", password: "set-in-v2-Passw0rd!" },
		});
		await makeAPIRequest(
			"/v1/auth/login",
			{ method: "POST", body: { username: "admin", password: "admin-from-v1" } },
			401,
		);
	});
});
