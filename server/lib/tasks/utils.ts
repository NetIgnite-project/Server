import { ConfigHandler } from "../utils/config";
import { Logger } from "../utils/logger";

export class TaskUtils {
	static getTaskLogFilePath(taskID: number): string {
		const config = ConfigHandler.getConfig();
		if (!config) {
			throw new Error("Config not loaded. Cannot determine log file path.");
		}

		return `${config.LOG_DIR}/tasks/task-${taskID}.log`;
	}

	static async getLogsForTask(taskID: number): Promise<string | null> {
		try {
			const logs = Bun.file(this.getTaskLogFilePath(taskID));

			if (!(await logs.exists())) {
				return null;
			}

			return await logs.text();
		} catch (err) {
			Logger.error("Failed to read task logs:", (err as Error).message);
			return null;
		}
	}
}
