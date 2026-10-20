import { defineNitroPlugin } from "nitropack/runtime";
import { AgentGatewayRunner } from "../lib/agents/gateway";
import { API } from "../lib/api";
import { EmailService } from "../lib/api/utils/email";
import { DB } from "../lib/db";
import { DeviceStatusService } from "../lib/devices/status";
import { FirmwareCatalog } from "../lib/firmware/catalog";
import { TaskScheduler } from "../lib/tasks";
import { Utils } from "../lib/utils";
import { ConfigHandler } from "../lib/utils/config";
import { AppConstants } from "../lib/utils/constants";
import { CronJobHandler } from "../lib/utils/cron";
import { Logger } from "../lib/utils/logger";

// Runs once at Nitro boot — replaces Main.main() from the standalone backend shape.
export default defineNitroPlugin(async (nitroApp) => {
	let shutdownPromise: Promise<boolean> | null = null;

	// Idempotent: every caller awaits the same run. Resolves to false if a step failed.
	function shutdown(reason: string) {
		shutdownPromise ??= (async () => {
			try {
				Logger.log(`Received ${reason}, shutting down...`);

				await CronJobHandler.stopAll();

				DeviceStatusService.stop();
				AgentGatewayRunner.stop();

				await API.stop();

				await EmailService.reset();
				await TaskScheduler.stopProcessing();

				await DB.close();

				Logger.log("Shutdown complete, exiting.");
				return true;
			} catch {
				Logger.critical("Error during shutdown, forcing exit");
				return false;
			}
		})();
		return shutdownPromise;
	}

	nitroApp.hooks.hook("close", async () => {
		await shutdown("close");
	});

	// The Bun preset installs no signal or error handlers and never calls the `close` hook.
	// Registered first: Nitro doesn't await this plugin, so the server already listens during startup.
	if (!import.meta.dev) {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, async () => {
				process.exit((await shutdown(signal)) ? 0 : 1);
			});
		}

		process.once("uncaughtException", async (error) => {
			Logger.critical(
				`Uncaught Exception:\n${Error.isError(error) ? (error.stack ?? error.message) : error}`,
			);
			await shutdown("uncaughtException");
			process.exit(1);
		});

		process.once("unhandledRejection", async (reason) => {
			Logger.critical(
				`Unhandled Rejection:\n${Error.isError(reason) ? (reason.stack ?? reason.message) : reason}`,
			);
			await shutdown("unhandledRejection");
			process.exit(1);
		});
	}

	const config = await ConfigHandler.loadConfig();

	Logger.setLogLevel(config.LOG_LEVEL ?? "info");
	Logger.log(`Starting ${AppConstants.APP_NAME}...`);

	await DB.init(
		config.DB_PATH,
		config.DB_AUTO_MIGRATE,
		config.CONFIG_BASE_DIR,
		config.DB_MIGRATION_DIR,
	);

	await Utils.ensureDirectoryExists(config.LOG_DIR ?? "./data/logs");

	await EmailService.init();

	await FirmwareCatalog.configure({
		repo: config.FIRMWARE_REPO,
		apiURL: "https://api.github.com",
		dir: config.FIRMWARE_DIR,
		publicKeyPath: config.FIRMWARE_PUBLIC_KEY ?? null,
		token: config.GITHUB_TOKEN ?? null,
	});

	await CronJobHandler.init();
	await CronJobHandler.startAll();

	// Not awaited: it runs the queued tasks to completion. Started before the API so that no
	// request can enqueue first (TaskHandler then skips loading the stored pending/paused tasks).
	TaskScheduler.processQueue().catch((err) => {
		Logger.error("Task queue processing failed:", err);
	});

	await API.init([config.APP_URL], config.API_DISABLE_DOCS === true);

	AgentGatewayRunner.start();
	DeviceStatusService.start();

	if (config.FIRMWARE_SYNC) {
		// In the background: the server is usable while the firmware downloads.
		void FirmwareCatalog.sync();
	}
});
