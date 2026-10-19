import { TaskHandler } from "@cleverjs/utils";
import { and, asc, eq, or } from "drizzle-orm";
import fs from "fs";
import { dirname } from "path";
import { DB } from "../db";
import { ConfigHandler } from "../utils/config";
import { Logger } from "../utils/logger";
import { SampleTask } from "./sampleTask";
import { TaskUtils } from "./utils";

type AdditionalTaskMeta = {
	created_by_user_id: number | null;
};
type TaskData = TaskHandler.BaseTaskData<AdditionalTaskMeta>;

function buildPendingTaskData(
	fn: TaskData["fn"],
	args: TaskData["args"],
	additionalMeta: AdditionalTaskMeta,
	execOpts?: TaskHandler.TaskExecOptions,
): Omit<TaskData, "id"> {
	return {
		...additionalMeta,
		fn,
		args,
		execOptions: execOpts ?? null,
		status: "pending",
		created_at: Date.now(),
		finished_at: null,
		result: null,
		message: null,
	};
}

export class TaskStorage extends TaskHandler.AbstractStorageDriver<TaskData, AdditionalTaskMeta> {
	private transportToDBFormat(task: TaskData, withID?: true): DB.Models.ScheduledTask;
	private transportToDBFormat(task: TaskData, withID: false): Omit<DB.Models.ScheduledTask, "id">;
	private transportToDBFormat(task: TaskData, withID = true): DB.Models.ScheduledTask {
		return {
			id: withID ? task.id! : (undefined as any),
			function: task.fn,
			created_by_user_id: task.created_by_user_id,
			args: task.args,
			status: task.status,
			autoDelete: task.execOptions?.autoDelete ?? false,
			storeLogs: task.execOptions?.storeLogs ?? false,
			created_at: task.created_at,
			finished_at: task.finished_at ?? null,
			result: task.result ?? null,
			message: task.message ?? null,
		};
	}

	private transportFromDBFormat(dbModel: DB.Models.ScheduledTask): TaskData {
		return {
			id: dbModel.id,
			fn: dbModel.function,
			created_by_user_id: dbModel.created_by_user_id,
			args: dbModel.args,
			status: dbModel.status,
			execOptions: {
				autoDelete: dbModel.autoDelete,
				storeLogs: dbModel.storeLogs,
			},
			created_at: dbModel.created_at,
			finished_at: dbModel.finished_at,
			result: dbModel.result,
			message: dbModel.message,
		};
	}

	async loadTask(id: number): Promise<TaskData | null> {
		const data = DB.instance()
			.select()
			.from(DB.Tables.scheduled_tasks)
			.where(eq(DB.Tables.scheduled_tasks.id, id))
			.get();
		if (!data) return null;
		return this.transportFromDBFormat(data);
	}

	async createTask(data: Omit<TaskData, "id">): Promise<number> {
		const result = DB.instance()
			.insert(DB.Tables.scheduled_tasks)
			.values(this.transportToDBFormat(data as any, false))
			.returning()
			.get();
		return result.id;
	}

	async updateTask(data: TaskData): Promise<void> {
		await DB.instance()
			.update(DB.Tables.scheduled_tasks)
			.set(this.transportToDBFormat(data, false))
			.where(eq(DB.Tables.scheduled_tasks.id, data.id!));
	}

	async deleteTask(id: number): Promise<void> {
		await DB.instance().delete(DB.Tables.scheduled_tasks).where(eq(DB.Tables.scheduled_tasks.id, id));
	}

	async loadPausedOrPendingTasks(): Promise<TaskData[]> {
		const rows = DB.instance()
			.select()
			.from(DB.Tables.scheduled_tasks)
			// paused or pending tasks, oldest first so earlier submissions run first
			.where(
				or(
					eq(DB.Tables.scheduled_tasks.status, "paused"),
					eq(DB.Tables.scheduled_tasks.status, "pending"),
				),
			)
			.orderBy(asc(DB.Tables.scheduled_tasks.created_at))
			.all();

		return rows.map((row) => this.transportFromDBFormat(row));
	}

	async loadFinishedTasksWithAutoDelete(): Promise<TaskData[]> {
		const rows = DB.instance()
			.select()
			.from(DB.Tables.scheduled_tasks)
			.where(
				and(
					eq(DB.Tables.scheduled_tasks.status, "completed"),
					eq(DB.Tables.scheduled_tasks.autoDelete, true),
				),
			)
			.orderBy(asc(DB.Tables.scheduled_tasks.finished_at))
			.all();
		return rows.map((row) => this.transportFromDBFormat(row));
	}

	async loadPausedTaskState(taskID: number): Promise<TaskHandler.TempPausedTaskState | null> {
		const row = DB.instance()
			.select()
			.from(DB.Tables.scheduled_tasks_paused_state)
			.where(eq(DB.Tables.scheduled_tasks_paused_state.task_id, taskID))
			.get();
		if (!row) return null;
		return {
			nextStepToExecute: row.next_step_to_execute,
			data: row.data,
		};
	}

	async savePausedTaskState(
		taskID: number,
		pausedState: TaskHandler.TempPausedTaskState,
	): Promise<void> {
		const existing = DB.instance()
			.select()
			.from(DB.Tables.scheduled_tasks_paused_state)
			.where(eq(DB.Tables.scheduled_tasks_paused_state.task_id, taskID))
			.get();
		if (existing) {
			await DB.instance()
				.update(DB.Tables.scheduled_tasks_paused_state)
				.set({
					next_step_to_execute: pausedState.nextStepToExecute,
					data: pausedState.data,
				})
				.where(eq(DB.Tables.scheduled_tasks_paused_state.task_id, taskID));
		} else {
			await DB.instance().insert(DB.Tables.scheduled_tasks_paused_state).values({
				task_id: taskID,
				next_step_to_execute: pausedState.nextStepToExecute,
				data: pausedState.data,
			});
		}
	}

	async deletePausedTaskState(taskID: number): Promise<void> {
		await DB.instance()
			.delete(DB.Tables.scheduled_tasks_paused_state)
			.where(eq(DB.Tables.scheduled_tasks_paused_state.task_id, taskID));
	}
}

class PersistentLogger implements TaskHandler.PersistentTaskLoggerLike {
	readonly type = "persistent";

	private readonly writeStream?: fs.WriteStream;
	constructor(taskID: number) {
		try {
			const filePath = TaskUtils.getTaskLogFilePath(taskID);
			// Synchronous: the stream below opens right away and must not race the directory creation.
			fs.mkdirSync(dirname(filePath), { recursive: true });

			this.writeStream = fs.createWriteStream(filePath, { flags: "a" });
			// The open happens asynchronously; without a listener a failure (full disk, read-only
			// volume) would be an uncaught exception.
			this.writeStream.on("error", (err) => {
				Logger.error("Persistent task logger failed:", err.message);
			});
		} catch (err) {
			Logger.error("Failed to create persistent task logger:", (err as Error).message);
		}
	}

	public debug(...msg: any[]) {
		this.writeSafe(this.formatLine("DEBUG", msg));
	}

	public info(...msg: any[]) {
		this.writeSafe(this.formatLine("INFO", msg));
	}

	public warn(...msg: any[]) {
		this.writeSafe(this.formatLine("WARN", msg));
	}

	public error(...msg: any[]) {
		this.writeSafe(this.formatLine("ERROR", msg));
	}

	private formatLine(level: string, msg: any[]) {
		// Tasks also log objects and errors; inspect them instead of printing "[object Object]".
		const text = msg.map((m) => (typeof m === "string" ? m : Bun.inspect(m))).join(" ");
		return `[${new Date(Date.now()).toISOString()}] [${level}] ${text}\n`;
	}

	async close() {
		if (!this.writeStream) {
			return Promise.resolve();
		}
		if (!this.writeStream.writable) {
			Logger.warn("Persistent task logger: write stream already closed");
			return Promise.resolve();
		}
		try {
			return new Promise<void>((resolve, reject) => {
				const stream = this.writeStream as fs.WriteStream;
				const cleanup = () => {
					stream.removeListener("error", onError);
				};
				const onError = (err: Error) => {
					cleanup();
					Logger.error("Error closing persistent task logger:", err.message);
					resolve(); // resolve rather than reject — closing is best-effort
				};
				stream.once("error", onError);
				stream.end(() => {
					cleanup();
					resolve();
				});
			});
		} catch (err) {
			Logger.error("Error closing persistent task logger:", (err as Error).message);
		}
		return Promise.resolve();
	}

	private writeSafe(data: string) {
		try {
			if (this.writeStream && this.writeStream.writable) {
				this.writeStream.write(data, (err) => {
					if (err) {
						Logger.error(`Trying to write: '${data}' but error occurred:`, err.message);
					}
				});
			} else {
				Logger.error(`Trying to write: '${data}' but no log file available`);
			}
		} catch (err) {
			Logger.error(`Trying to write: '${data}' but error occurred:`, (err as Error).message);
		}
	}
}

const Registry = new TaskHandler.TaskFNRegistry().register(SampleTask);

const taskStorage = new TaskStorage();

export const TaskScheduler = new TaskHandler<
	(typeof Registry)["registry"],
	InstanceType<typeof TaskStorage>,
	TaskData,
	AdditionalTaskMeta
>(
	{
		storage: taskStorage,
		defaultLogger: Logger,
		persistentLogger: PersistentLogger,
	},
	Registry,
);

/**
 * @deprecated Use `TaskScheduler.enqueueTask(fn, args, additionalMeta, execOpts)`, which stores the
 * task and queues it in one call. `activatePendingTask` reaches into TaskHandler's private queue.
 */
export class TaskQueueUtils {
	static async createPendingTaskRecord(
		fn: TaskData["fn"],
		args: TaskData["args"],
		additionalMeta: AdditionalTaskMeta,
		execOpts?: TaskHandler.TaskExecOptions,
	) {
		return await taskStorage.createTask(buildPendingTaskData(fn, args, additionalMeta, execOpts));
	}

	static async activatePendingTask(taskID: number) {
		const task = await taskStorage.loadTask(taskID);

		if (!task) {
			throw new Error(`Task ${taskID} not found after creation.`);
		}

		// Access the pending-tasks queue via the public processQueue method.
		// The internal pending queue is not part of the documented API, so we
		// rely on the queue being populated by enqueueTask for the scheduler to pick up.
		(TaskScheduler as any).pendingTasks.push(task);
		void TaskScheduler.processQueue();
	}

	static async deleteTaskRecord(taskID: number) {
		await taskStorage.deleteTask(taskID);
	}
}
