import type { CronJob as BunCronJob } from "bun";
import { FirmwareCatalog } from "../firmware/catalog";
import { ConfigHandler } from "./config";
import { Logger } from "./logger";

class CronJob {
	private _job: BunCronJob | null = null;

	constructor(
		private readonly cronExpression: string,
		private readonly callback: () => Promise<void>,
	) {}

	start() {
		// A rejected Bun.cron callback ends the process, so a failing run is logged instead.
		this._job = Bun.cron(this.cronExpression, async () => {
			try {
				await this.callback();
			} catch (err) {
				Logger.error(`Cron job "${this.cronExpression}" failed:`, err);
			}
		});
	}

	async stop() {
		if (this._job) {
			await this._job.stop();
		}
	}
}

export class CronJobHandler {
	private static jobs: CronJob[] = [];
	private static initialized: boolean = false;

	static async init() {
		if (this.initialized) return;
		this.initialized = true;

		if (ConfigHandler.getConfig()?.FIRMWARE_SYNC) {
			// New firmware releases (every 6 hours, off the hour to spread GitHub API requests).
			this.jobs.push(
				new CronJob("17 */6 * * *", async () => {
					await FirmwareCatalog.sync();
				}),
			);
		}
	}

	static async startAll() {
		if (!this.initialized) {
			await this.init();
		}
		for (const job of this.jobs) {
			job.start();
		}
	}

	static async stopAll() {
		for (const job of this.jobs) {
			await job.stop();
		}
	}
}
