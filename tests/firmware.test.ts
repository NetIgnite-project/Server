import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { API } from "../server/lib/api";
import { FirmwareCatalog } from "../server/lib/firmware/catalog";
import { NVSImage } from "../server/lib/firmware/nvs";
import { ConfigHandler } from "../server/lib/utils/config";
import { makeAPIRequest } from "./helpers/api";
import { type SeededSession, seedSession, seedUser } from "./helpers/seed";

// --- A fake GitHub: the releases API and the asset downloads -----------------------------------

type FakeRelease = {
	tag: string;
	prerelease?: boolean;
	draft?: boolean;
	files: Record<string, Uint8Array<ArrayBuffer>>;
};

let releases: FakeRelease[] = [];
let githubStatus = 200;
let github: ReturnType<typeof Bun.serve>;

function sha256(data: Uint8Array) {
	return createHash("sha256").update(data).digest("hex");
}

/** A release like the Agent-ESP32 CI builds it (scripts/collect_release.py). */
function firmwareRelease(
	version: string,
	options: { prerelease?: boolean; signWith?: string; corrupt?: boolean } = {},
): FakeRelease {
	const parts: [string, number, number][] = [
		["bootloader.bin", 0x1000, 300],
		["partitions.bin", 0x8000, 3072],
		["boot_app0.bin", 0xe000, 8192],
		["firmware.bin", 0x10000, 50_000],
	];
	const files: Record<string, Uint8Array<ArrayBuffer>> = {};
	for (const [name, , size] of parts) {
		files[name] = crypto.getRandomValues(new Uint8Array(size));
	}
	if (options.signWith) {
		files["firmware.sig"] = new Uint8Array(
			sign("sha256", files["firmware.bin"] as Uint8Array, options.signWith),
		);
	}

	const manifest = {
		format: 1,
		name: "NetIgnite Agent",
		version,
		chip_family: "ESP32",
		board: "esp32dev",
		protocol: 2,
		parts: parts.map(([file, offset]) => ({
			file,
			offset,
			size: (files[file] as Uint8Array).length,
			sha256: sha256(files[file] as Uint8Array),
		})),
		nvs: { offset: 0x9000, size: 0x5000, namespace: "netignite", keys: ["server", "enroll", "name"] },
		app: { file: "firmware.bin", signature: options.signWith ? "firmware.sig" : null },
	};
	if (options.corrupt) {
		const app = files["firmware.bin"] as Uint8Array;
		app[0] = (app[0] as number) ^ 0xff;
	}
	files["release.json"] = new TextEncoder().encode(JSON.stringify(manifest));

	return { tag: `v${version}`, prerelease: options.prerelease, files };
}

let admin: SeededSession;
let owner: SeededSession;
let stranger: SeededSession;
let firmwareDir: string;

beforeAll(async () => {
	github = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/repos/NetIgnite-project/Agent-ESP32/releases") {
				if (githubStatus !== 200) return new Response("boom", { status: githubStatus });
				return Response.json(
					releases.map((release, index) => ({
						tag_name: release.tag,
						html_url: `https://github.com/NetIgnite-project/Agent-ESP32/releases/tag/${release.tag}`,
						body: `Notes for ${release.tag}`,
						draft: release.draft ?? false,
						prerelease: release.prerelease ?? false,
						created_at: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
						published_at: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
						assets: Object.entries(release.files).map(([name, data]) => ({
							name,
							size: data.length,
							browser_download_url: `${url.origin}/download/${release.tag}/${name}`,
						})),
					})),
				);
			}
			const match = url.pathname.match(/^\/download\/([^/]+)\/([^/]+)$/);
			const data = match && releases.find((r) => r.tag === match[1])?.files[match[2] as string];
			return data ? new Response(data) : new Response("not found", { status: 404 });
		},
	});

	firmwareDir = ConfigHandler.getConfig()?.FIRMWARE_DIR as string;
	await FirmwareCatalog.configure({
		repo: "NetIgnite-project/Agent-ESP32",
		apiURL: github.url.origin,
		dir: firmwareDir,
		publicKeyPath: null,
		token: null,
	});

	admin = await seedSession((await seedUser("admin")).id);
	owner = await seedSession((await seedUser("user")).id);
	stranger = await seedSession((await seedUser("user")).id);
});

afterAll(() => {
	github.stop(true);
});

async function createAgent(token: string, kind: "esp32" | "linux") {
	return await makeAPIRequest<{ id: number }>("/v1/agents", {
		method: "POST",
		authToken: token,
		body: { name: `Garage ${kind}`, kind },
	});
}

describe("Firmware catalog", () => {
	test("sync keeps valid releases and skips broken, draft and v1 ones", async () => {
		const v1 = firmwareRelease("1.0.0");
		delete v1.files["release.json"];
		releases = [
			v1,
			firmwareRelease("2.0.0"),
			firmwareRelease("2.0.1", { corrupt: true }),
			firmwareRelease("2.1.0-beta.1", { prerelease: true }),
			{ ...firmwareRelease("9.0.0"), draft: true },
		];

		const result = await FirmwareCatalog.sync();
		expect(result.error).toBeNull();
		expect(result.added.sort()).toEqual(["2.0.0", "2.1.0-beta.1"]);
		expect(result.skipped).toEqual([
			{ version: "2.0.1", reason: "firmware.bin doesn't match its SHA-256" },
		]);

		const catalog = await makeAPIRequest<{
			channel: string;
			recommended: string | null;
			releases: { version: string; prerelease: boolean; parts: { file: string }[] }[];
		}>("/v1/firmware", { authToken: owner.token });

		expect(catalog.channel).toBe("stable");
		expect(catalog.recommended).toBe("2.0.0");
		expect(catalog.releases.map((r) => r.version)).toEqual(["2.1.0-beta.1", "2.0.0"]);
		expect(catalog.releases[0]?.prerelease).toBe(true);

		// Nothing half-downloaded is left behind.
		expect((await fs.readdir(firmwareDir)).sort()).toEqual(["2.0.0", "2.1.0-beta.1"]);
	});

	test("a second sync downloads nothing again", async () => {
		const result = await FirmwareCatalog.sync();
		expect(result.added).toEqual([]);
		expect(result.skipped.map((s) => s.version)).toEqual(["2.0.1"]);
	});

	test("serves the flash images to signed-in users only", async () => {
		const release = releases.find((r) => r.tag === "v2.0.0") as FakeRelease;

		const res = await API.getApp().request("/v1/firmware/2.0.0/files/firmware.bin", {
			headers: { Authorization: `Bearer ${owner.token}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe(String(release.files["firmware.bin"]?.length));
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			release.files["firmware.bin"] as Uint8Array<ArrayBuffer>,
		);

		await makeAPIRequest("/v1/firmware/2.0.0/files/firmware.bin", {}, 401);
		await makeAPIRequest("/v1/firmware/2.0.0/files/release.json", { authToken: owner.token }, 404);
		await makeAPIRequest("/v1/firmware/2.0.0/files/secret.txt", { authToken: owner.token }, 404);
		await makeAPIRequest("/v1/firmware/9.9.9/files/firmware.bin", { authToken: owner.token }, 404);
		await makeAPIRequest(
			"/v1/firmware/..%2F..%2Fdb/files/firmware.bin",
			{ authToken: owner.token },
			400,
		);
	});

	test("the admin picks the channel", async () => {
		await makeAPIRequest(
			"/v1/admin/settings",
			{ method: "PUT", authToken: owner.token, body: { firmware_channel: "prerelease" } },
			403,
		);

		const settings = await makeAPIRequest<{
			firmware_channel: string;
			registration_enabled: boolean;
		}>("/v1/admin/settings", {
			method: "PUT",
			authToken: admin.token,
			body: { firmware_channel: "prerelease" },
		});
		expect(settings.firmware_channel).toBe("prerelease");

		const catalog = await makeAPIRequest<{ recommended: string }>("/v1/firmware", {
			authToken: owner.token,
		});
		expect(catalog.recommended).toBe("2.1.0-beta.1");

		await makeAPIRequest("/v1/admin/settings", {
			method: "PUT",
			authToken: admin.token,
			body: { firmware_channel: "stable" },
		});
	});

	test("admins can sync manually; GitHub errors are reported", async () => {
		await makeAPIRequest("/v1/admin/firmware/sync", { method: "POST", authToken: owner.token }, 403);

		const result = await makeAPIRequest<{
			added: string[];
			state: { error: string | null; last_success_at: number };
		}>("/v1/admin/firmware/sync", { method: "POST", authToken: admin.token });
		expect(result.added).toEqual([]);
		expect(result.state.error).toBeNull();
		expect(result.state.last_success_at).toBeGreaterThan(0);

		githubStatus = 500;
		await makeAPIRequest("/v1/admin/firmware/sync", { method: "POST", authToken: admin.token }, 502);
		const state = await makeAPIRequest<{ error: string; last_success_at: number }>(
			"/v1/admin/firmware",
			{
				authToken: admin.token,
			},
		);
		expect(state.error).toContain("500");
		expect(state.last_success_at).toBe(result.state.last_success_at);
		githubStatus = 200;

		// A failed listing never removes releases.
		expect((await FirmwareCatalog.list()).length).toBe(2);
	});

	test("releases removed from GitHub are removed locally", async () => {
		releases = releases.filter((r) => r.tag !== "v2.1.0-beta.1");
		const result = await FirmwareCatalog.sync();
		expect(result.removed).toEqual(["2.1.0-beta.1"]);
		expect(await fs.readdir(firmwareDir)).toEqual(["2.0.0"]);
	});
});

describe("Flash image", () => {
	test("contains the server URL, the agent's name and a working single-use enrollment token", async () => {
		const agent = await createAgent(owner.token, "esp32");

		const res = await API.getApp().request(`/v1/agents/${agent.id}/flash-image`, {
			method: "POST",
			headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ version: "2.0.0" }),
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toBe("no-store");

		const { data } = (await res.json()) as {
			data: { image: string; offset: number; server_url: string; expires_at: number };
		};
		expect(data.offset).toBe(0x9000);
		expect(data.server_url).toBe("http://localhost:18232");

		const image = new Uint8Array(Buffer.from(data.image, "base64"));
		expect(image.length).toBe(0x5000);
		const text = new TextDecoder("latin1").decode(image);
		expect(text).toContain("http://localhost:18232\0");
		expect(text).toContain("Garage esp32\0");

		// Page header: active, version 2.
		expect(new DataView(image.buffer).getUint32(0, true)).toBe(0xfffffffe);
		expect(image[8]).toBe(0xfe);

		const token = text.match(/netignite_enroll_[A-Za-z0-9]+:[A-Za-z0-9_-]+/)?.[0] as string;
		expect(token).toBeDefined();

		const secret = "a".repeat(64);
		const enrolled = await makeAPIRequest<{ agent_id: number }>("/v1/agents/enroll", {
			method: "POST",
			body: { enrollment_token: token, secret },
		});
		expect(enrolled.agent_id).toBe(agent.id);
		await makeAPIRequest(
			"/v1/agents/enroll",
			{ method: "POST", body: { enrollment_token: token, secret } },
			401,
		);
	});

	test("matches the image Espressif's tool would create", async () => {
		const agent = await createAgent(owner.token, "esp32");
		const data = await makeAPIRequest<{ image: string }>(`/v1/agents/${agent.id}/flash-image`, {
			method: "POST",
			authToken: owner.token,
			body: { version: "2.0.0", server_url: "https://netignite.example/base/" },
		});
		const image = new Uint8Array(Buffer.from(data.image, "base64"));
		const token = new TextDecoder("latin1")
			.decode(image)
			.match(/netignite_enroll_[^\0]+/)?.[0] as string;

		const expected = NVSImage.generate(
			[
				{
					name: "netignite",
					entries: {
						server: { type: "string", value: "https://netignite.example/base" },
						enroll: { type: "string", value: token },
						name: { type: "string", value: "Garage esp32" },
					},
				},
			],
			0x5000,
		);
		expect(image).toEqual(expected);
	});

	test("a new image invalidates the previous one's token", async () => {
		const agent = await createAgent(owner.token, "esp32");
		const tokenOf = async () => {
			const data = await makeAPIRequest<{ image: string }>(`/v1/agents/${agent.id}/flash-image`, {
				method: "POST",
				authToken: owner.token,
				body: { version: "2.0.0" },
			});
			return new TextDecoder("latin1")
				.decode(Buffer.from(data.image, "base64"))
				.match(/netignite_enroll_[^\0]+/)?.[0];
		};
		const first = await tokenOf();
		const second = await tokenOf();

		const secret = "b".repeat(64);
		await makeAPIRequest(
			"/v1/agents/enroll",
			{ method: "POST", body: { enrollment_token: first, secret } },
			401,
		);
		await makeAPIRequest("/v1/agents/enroll", {
			method: "POST",
			body: { enrollment_token: second, secret },
		});
	});

	test("only for the owner's ESP32 agents, known releases and plain http(s) URLs", async () => {
		const esp = await createAgent(owner.token, "esp32");
		const linux = await createAgent(owner.token, "linux");
		const request = (id: number, token: string, body: Record<string, unknown>, code: number) =>
			makeAPIRequest(`/v1/agents/${id}/flash-image`, { method: "POST", authToken: token, body }, code);

		await request(linux.id, owner.token, { version: "2.0.0" }, 400);
		await request(esp.id, stranger.token, { version: "2.0.0" }, 404);
		await request(esp.id, owner.token, { version: "9.9.9" }, 404);
		await request(esp.id, owner.token, { version: "2.0.0", server_url: "ftp://example.com" }, 400);
		await request(
			esp.id,
			owner.token,
			{ version: "2.0.0", server_url: "https://user:pw@example.com" },
			400,
		);
		await request(
			esp.id,
			owner.token,
			{ version: "2.0.0", server_url: "https://example.com/?a=b" },
			400,
		);
		await makeAPIRequest(
			`/v1/agents/${esp.id}/flash-image`,
			{ method: "POST", body: { version: "2.0.0" } },
			401,
		);
	});
});

describe("Firmware signatures", () => {
	test("with a public key, only correctly signed releases are accepted", async () => {
		const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const otherKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const wrongKey = otherKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

		const keyPath = path.join(firmwareDir, "..", "firmware-signing.pub.pem");
		await Bun.write(keyPath, keys.publicKey.export({ type: "spki", format: "pem" }).toString());

		const signedDir = path.join(firmwareDir, "..", "firmware-signed");
		await FirmwareCatalog.configure({
			repo: "NetIgnite-project/Agent-ESP32",
			apiURL: github.url.origin,
			dir: signedDir,
			publicKeyPath: keyPath,
			token: null,
		});

		releases = [
			firmwareRelease("3.0.0"),
			firmwareRelease("3.0.1", { signWith: wrongKey }),
			firmwareRelease("3.0.2", { signWith: privateKey }),
		];
		const result = await FirmwareCatalog.sync();
		expect(result.added).toEqual(["3.0.2"]);
		expect(Object.fromEntries(result.skipped.map((s) => [s.version, s.reason]))).toEqual({
			"3.0.0": "the release isn't signed, but FIRMWARE_PUBLIC_KEY requires a signature",
			"3.0.1": "the firmware signature is invalid",
		});

		const release = await FirmwareCatalog.get("3.0.2");
		expect(release?.signature_verified).toBe(true);
		// The signature is served too (for OTA updates).
		await makeAPIRequest("/v1/firmware/3.0.2/files/firmware.sig", { authToken: owner.token });
	});
});
