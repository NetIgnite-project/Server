/**
 * Imports a NetIgnite v1 database into this server's database.
 *
 *   bun scripts/import-v1.ts --from ./data/db.sqlite [--dry-run] [--merge-users]
 *
 * `--merge-users` merges v1 users into existing v2 users with the same username; without it only
 * the v1 `admin` is merged into the server's initial `admin`.
 *
 * In the Docker image (bundled by `bun run build` as `.output/import-v1.mjs`):
 *
 *   docker exec netignite-server bun /opt/netignite/app/.output/import-v1.mjs --from /opt/netignite/data/db.sqlite
 *
 * Uses the same NETIGNITE_* configuration as the server. Safe to run more than once.
 */
import { parseArgs } from "node:util";
import { DB } from "../server/lib/db";
import { V1Importer } from "../server/lib/migration/v1Import";
import { ConfigHandler } from "../server/lib/utils/config";
import { Logger } from "../server/lib/utils/logger";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		from: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		"merge-users": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help || !values.from) {
	console.log("Usage: import-v1 --from <path to v1 db.sqlite> [--dry-run] [--merge-users]");
	process.exit(values.help ? 0 : 1);
}

const config = await ConfigHandler.loadConfig();
Logger.setLogLevel(config.LOG_LEVEL ?? "info");

await DB.init(config.DB_PATH, true, config.CONFIG_BASE_DIR, config.DB_MIGRATION_DIR);

try {
	const report = await V1Importer.run({
		sourcePath: values.from,
		dryRun: values["dry-run"],
		configBaseDir: config.CONFIG_BASE_DIR,
		mergeUsers: values["merge-users"],
	});

	console.log(values["dry-run"] ? "\nDry run — nothing was changed.\n" : "\nImport finished.\n");
	console.log(`Users imported: ${report.users.imported.length}`);
	console.log(`Users merged:   ${report.users.merged.join(", ") || "-"}`);
	for (const skipped of report.users.skipped)
		console.log(`  skipped user ${skipped.username}: ${skipped.reason}`);
	console.log(`Agents imported: ${report.agents.imported}`);
	for (const skipped of report.agents.skipped)
		console.log(`  skipped agent ${skipped.name}: ${skipped.reason}`);
	console.log(`Devices imported: ${report.devices.imported}`);
	for (const skipped of report.devices.skipped)
		console.log(`  skipped device ${skipped.name}: ${skipped.reason}`);
	console.log(`Favorites imported: ${report.favorites}`);

	if (!values["dry-run"] && report.agents.imported > 0) {
		console.log(
			"\nImported agents have to be set up again: flash ESP32 agents with the v2 firmware from the " +
				"dashboard, and pair Linux agents with `netignite-agent pair`.",
		);
	}
	if (report.users.imported.length > 0) {
		console.log(
			`Imported users got a placeholder email (…@${V1Importer.PLACEHOLDER_EMAIL_DOMAIN}) and are asked to change it after logging in.`,
		);
	}
} finally {
	await DB.close();
}
