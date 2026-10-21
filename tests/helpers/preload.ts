/// <reference types="bun-types" />

import { afterAll, beforeAll } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { API } from "../../server/lib/api";
import { DB } from "../../server/lib/db";
import { Utils } from "../../server/lib/utils";
import { ConfigHandler, type ENVConfigLike } from "../../server/lib/utils/config";

function setTestEnv(rootDir: string) {
	const envVars = {
		NETIGNITE_LOG_LEVEL: "debug",

		NETIGNITE_API_DISABLE_DOCS: false,

		NETIGNITE_DB_PATH: path.join(rootDir, "db.sqlite"),
		NETIGNITE_DB_AUTO_MIGRATE: true,
		NETIGNITE_DB_MIGRATION_DIR: "./drizzle/migrations",

		NETIGNITE_LOG_DIR: path.join(rootDir, "logs"),
		NETIGNITE_CONFIG_BASE_DIR: rootDir,

		NETIGNITE_APP_URL: "http://localhost:18232",

		// Tests configure the catalog with a fake GitHub (tests/firmware.test.ts).
		NETIGNITE_FIRMWARE_SYNC: false,
		NETIGNITE_FIRMWARE_REPO: "NetIgnite-project/Agent-ESP32",
		NETIGNITE_FIRMWARE_DIR: path.join(rootDir, "firmware"),
		NETIGNITE_FIRMWARE_PUBLIC_KEY: undefined,
		NETIGNITE_GITHUB_TOKEN: undefined,
		NETIGNITE_LINUX_AGENT_REPO: "NetIgnite-project/Agent-Linux",
		NETIGNITE_LINUX_AGENT_VERSION: undefined,

		NETIGNITE_SMTP_HOST: "127.0.0.1",
		NETIGNITE_SMTP_PORT: 12587,
		NETIGNITE_SMTP_USERNAME: "",
		NETIGNITE_SMTP_PASSWORD: "",
		NETIGNITE_SMTP_FROM: '"App Test" <test@app.local>',
		NETIGNITE_SMTP_SECURE: false,
	} as const satisfies ENVConfigLike;

	for (const [key, value] of Object.entries(envVars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = String(value);
	}
}

async function createIsolatedDataDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.cwd(), "tmp-data-"));
	return root;
}

async function runCommand(cmd: string[]) {
	const process = Bun.spawn({
		cmd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		process.stdout ? new Response(process.stdout).text() : Promise.resolve(""),
		process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
		process.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr || stdout}`.trim());
	}
}

/**
 * On Windows, file handles (e.g. the SQLite DB file) can take a moment to be
 * released after closing, making an immediate recursive removal flaky (EBUSY).
 * Retries manually since Bun's `fs.rm` doesn't reliably honor `maxRetries`/`retryDelay`.
 */
async function removeDirWithRetry(dir: string, attempts = 10, delayMs = 300) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		} catch (err: any) {
			if (
				attempt === attempts ||
				(err?.code !== "EBUSY" && err?.code !== "ENOTEMPTY" && err?.code !== "EPERM")
			) {
				console.error(`Failed to remove directory ${dir} on attempt ${attempt}:`, err);
			}
			await Bun.sleep(delayMs);
		}
	}
}

let TMP_ROOT: string | null = null;

beforeAll(async () => {
	TMP_ROOT = await createIsolatedDataDir();

	setTestEnv(TMP_ROOT);

	const config = await ConfigHandler.loadConfig();

	await DB.init(path.join(TMP_ROOT, "db.sqlite"), true, TMP_ROOT, "./drizzle/migrations");

	// EmailService is NOT initialised here — tests that need it call
	// EmailService.init(mockTransport) in their own beforeAll.

	await API.init([config.APP_URL], false);

	// await API.start(12521, "::");
});

afterAll(async () => {
	await API.stop();

	await DB.close();

	if (TMP_ROOT) {
		await removeDirWithRetry(TMP_ROOT);
	}
});
