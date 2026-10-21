import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdir as fs_mkdir } from "fs/promises";
import { dirname as path_dirname, join as path_join } from "path";
import { ConfigHandler } from "../utils/config";
import { AppConstants } from "../utils/constants";
import { LCrypt } from "../utils/crypto/lcrypt";
import { Logger } from "../utils/logger";
import * as TableSchema from "./schema";
import { type DrizzleDB } from "./utils";

export class DB {
	protected static db: DrizzleDB.BunSQLite;

	static async init(
		path: string,
		autoMigrate: boolean,
		configBaseDir: string,
		migrationsFolder: string,
	) {
		await fs_mkdir(path_dirname(path), { recursive: true });
		await fs_mkdir(configBaseDir, { recursive: true });

		this.db = drizzle(path);
		if (autoMigrate) {
			Logger.info("Running database migrations...");

			//@ts-ignore
			if (Bun?.isStandaloneExecutable) {
				// `bun build --compile --asset ./drizzle/migrations` embeds the files as `migrations/...`
				// next to the entry (`/$bunfs/root/migrations` on Linux) — without the `drizzle/` segment.
				migrationsFolder = path_join(import.meta.dir, "migrations");
			}

			await migrate(this.db, { migrationsFolder });

			Logger.info("Database migrations completed.");
		}

		// SQLite leaves foreign keys off unless enabled per connection; the schema's
		// `onDelete` rules (shares, favorites, enrollments) depend on them.
		this.db.run(sql`PRAGMA foreign_keys = ON`);

		await this.createInitialAdminUserIfNeeded(configBaseDir);

		Logger.info(`Database initialized at ${path}`);
	}

	private static async createInitialAdminUserIfNeeded(configBaseDir: string) {
		const usersTableEmpty = (await this.db.select().from(DB.Tables.users).limit(1)).length === 0;
		if (!usersTableEmpty) return;

		const username = "admin";
		const passwordResetToken = LCrypt.randomBytes(64).toString("hex");

		let admin_user_id: number;

		try {
			admin_user_id = await this.db.transaction(async (tx) => {
				const admin_user_id = await tx
					.insert(DB.Tables.users)
					.values({
						username,
						email: `${username}@${AppConstants.DEFAULT_EMAIL_FROM_HOST}`,
						password_hash: await Bun.password.hash(LCrypt.randomBytes(32).toString("hex")),
						display_name: "Default Administrator",
						role: "admin",
					})
					.returning()
					.get().id;

				await tx.insert(DB.Tables.passwordResets).values({
					token: LCrypt.sha256(passwordResetToken).toHex(),
					user_id: admin_user_id,
					expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 Days
				});

				return admin_user_id;
			});
		} catch (error) {
			Logger.critical("Failed to create initial admin user:", error);
			throw error;
		}

		// APP_URL is a required config value; the fallback only covers the
		// impossible-after-loadConfig undefined case so the token file is still usable.
		const APP_URL = ConfigHandler.getConfig()?.APP_URL || "https://<app-url>";

		await Bun.write(
			`${configBaseDir}/initial_admin_password_reset_token.txt`,
			`${APP_URL}/auth/reset-password?token=${passwordResetToken}`,
			{
				mode: 0o600,
				createPath: true,
			},
		);

		Logger.info(
			`Initial admin user created with username: ${username}.\n` +
				`You can set the password under ${APP_URL}/auth/reset-password?token=${passwordResetToken}\n` +
				`The url is also saved at ${configBaseDir}/initial_admin_password_reset_token.txt\n`,
		);

		return admin_user_id;
	}

	static instance() {
		if (!this.db) {
			throw new Error("Database not initialized. Call DB.init() first.");
		}
		return DB.db;
	}

	static async close() {
		if (!this.db) return;

		Logger.info("Database connection closed.");
		await this.db.$client.close();

		// `close()` calls sqlite3_close_v2, which defers releasing the OS file
		// handle until any unfinalized prepared statements are garbage collected.
		// Force that now so the underlying file is actually free (e.g. for tests
		// that remove the DB file/directory right after closing).
		Bun.gc(true);
		await Bun.sleep(500);
	}
}

export namespace DB.Tables {
	export const users = TableSchema.users;
	export const sessions = TableSchema.sessions;
	export const passwordResets = TableSchema.passwordResets;
	export const apiKeys = TableSchema.apiKeys;

	export const userPreferences = TableSchema.userPreferences;

	export const scheduled_tasks = TableSchema.scheduled_tasks;
	export const scheduled_tasks_paused_state = TableSchema.scheduled_tasks_paused_state;

	export const metadata = TableSchema.metadata;

	export const agents = TableSchema.agents;
	export const agentEnrollments = TableSchema.agentEnrollments;
	export const devices = TableSchema.devices;
	export const deviceShares = TableSchema.deviceShares;
	export const deviceFavorites = TableSchema.deviceFavorites;
	export const firmwareReleases = TableSchema.firmwareReleases;
	export const deviceSshCredentials = TableSchema.deviceSshCredentials;
}

export namespace DB.Models {
	export type User = typeof DB.Tables.users.$inferSelect;
	export type Session = typeof DB.Tables.sessions.$inferSelect;
	export type PasswordReset = typeof DB.Tables.passwordResets.$inferSelect;
	export type ApiKey = typeof DB.Tables.apiKeys.$inferSelect;

	export type UserPreference = typeof DB.Tables.userPreferences.$inferSelect;

	export type ScheduledTask = typeof DB.Tables.scheduled_tasks.$inferSelect;
	export type ScheduledTaskPausedState = typeof DB.Tables.scheduled_tasks_paused_state.$inferSelect;

	export type Metadata = typeof DB.Tables.metadata.$inferSelect;

	export type Agent = typeof DB.Tables.agents.$inferSelect;
	export type AgentEnrollment = typeof DB.Tables.agentEnrollments.$inferSelect;
	export type Device = typeof DB.Tables.devices.$inferSelect;
	export type DeviceShare = typeof DB.Tables.deviceShares.$inferSelect;
	export type DeviceFavorite = typeof DB.Tables.deviceFavorites.$inferSelect;
	export type FirmwareRelease = typeof DB.Tables.firmwareReleases.$inferSelect;
	export type DeviceSshCredential = typeof DB.Tables.deviceSshCredentials.$inferSelect;
}
