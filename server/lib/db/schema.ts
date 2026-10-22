import type { TaskHandler } from "@cleverjs/utils";
import { desc, eq, sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { UserAccountSettings } from "../api/utils/shared-models/accountData";
import {
	AgentSettings,
	DeviceSettings,
	type FirmwareSettings,
	ShareSettings,
} from "../api/utils/shared-models/netigniteData";
import { SQLUtils } from "./utils";

/**
 * @deprecated Use DB.Tables.users to access this table.
 */
export const users = sqliteTable("users", {
	id: SQLUtils.primaryKeyIntAutoIncrement("id"),

	username: text().notNull().unique(),
	display_name: text().notNull(),
	email: text().notNull().unique(),
	password_hash: text().notNull(),

	role: text({
		enum: UserAccountSettings.Roles,
	})
		.default("user")
		.notNull(),

	created_at: SQLUtils.getCreatedAtColumn(),
});

/**
 * @deprecated Use DB.Tables.passwordResets to access this table.
 */
export const passwordResets = sqliteTable("password_resets", {
	token: text().primaryKey(),
	user_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * @deprecated Use DB.Tables.sessions to access this table.
 */
export const sessions = sqliteTable("sessions", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	user_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	// we cache user role here for easier permission checking without having to join the users table, and we will check the role in users table on every update to make sure it's still valid
	user_role: text({
		enum: UserAccountSettings.Roles,
	}).notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * @deprecated Use DB.Tables.apiKeys to access this table.
 */
export const apiKeys = sqliteTable("api_keys", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	user_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	// we cache user role here for easier permission checking without having to join the users table, and we will check the role in users table on every update to make sure it's still valid
	user_role: text({
		enum: UserAccountSettings.Roles,
	}).notNull(),
	description: text().notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer(),
});

/**
 * @deprecated Use DB.Tables.userPreferences to access this table.
 */
export const userPreferences = sqliteTable(
	"user_preferences",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		created_at: SQLUtils.getCreatedAtColumn(),

		// Preference key, e.g. "remote-content-policy".
		key: text().notNull(),
		data: text({ mode: "json" }).$type<Record<string, any> | Array<any>>().notNull(),
	},
	(table) => [uniqueIndex("user_preferences_user_id_key_unique").on(table.user_id, table.key)],
);

/**
 * @deprecated Use DB.Tables.scheduled_tasks to access this table.
 */
export const scheduled_tasks = sqliteTable("scheduled_tasks", {
	id: integer().primaryKey({ autoIncrement: true }),
	function: text().notNull(),
	created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
	args: text({ mode: "json" }).$type<Record<string, any>>().notNull(),
	autoDelete: integer({ mode: "boolean" }).notNull().default(sql`0`),
	storeLogs: integer({ mode: "boolean" }).notNull().default(sql`0`),
	status: text({ enum: ["pending", "running", "paused", "failed", "completed"] })
		.notNull()
		.default("pending"),
	created_at: integer().notNull(),
	finished_at: integer(),
	result: text({ mode: "json" }).$type<Record<string, any>>(),
	message: text(),
});

/**
 * @deprecated Use DB.Tables.scheduled_tasks_paused_state to access this table.
 */
export const scheduled_tasks_paused_state = sqliteTable("scheduled_tasks_paused_state", {
	task_id: integer()
		.primaryKey()
		.references(() => scheduled_tasks.id, { onDelete: "cascade" }),
	next_step_to_execute: integer().notNull(),
	data: text({ mode: "json" }).$type<TaskHandler.TempPausedTaskState["data"]>().notNull(),
});

/**
 * @deprecated Use DB.Tables.metadata to access this table.
 */
export const metadata = sqliteTable("metadata", {
	key: text().primaryKey(),
	data: text({ mode: "json" }).$type<Record<string, any> | Array<any>>().notNull(),
});

/**
 * @deprecated Use DB.Tables.agents to access this table.
 */
export const agents = sqliteTable("agents", {
	id: SQLUtils.primaryKeyIntAutoIncrement("id"),
	owner_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),

	name: text().notNull(),
	description: text().notNull().default(""),
	kind: text({ enum: AgentSettings.Kinds }).notNull(),

	// Set when the agent enrolls. The agent generates the secret itself; only its hash is stored.
	// Full credential: `netignite_agent_<token_id>:<secret>`.
	token_id: text().unique(),
	hashed_secret: text(),
	enrolled_at: integer(),

	// Reported by the agent's HELLO.
	capabilities: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
	version: text(),
	info: text({ mode: "json" }).$type<Record<string, unknown>>(),
	/** The agent's SSH public keys (`ssh-ed25519 …`); the private keys never leave the agent. */
	ssh_keys: text({ mode: "json" }).$type<{ shutdown: string; reboot: string }>(),
	last_seen_at: integer(),

	created_at: SQLUtils.getCreatedAtColumn(),
});

/**
 * @deprecated Use DB.Tables.agentEnrollments to access this table.
 *
 * Single-use enrollment tokens (`netignite_enroll_<id>:<base>`), embedded in the ESP32 flash image
 * or passed to `netignite-agent pair`.
 */
export const agentEnrollments = sqliteTable("agent_enrollments", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	agent_id: integer()
		.notNull()
		.references(() => agents.id, { onDelete: "cascade" }),
	created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
	used_at: integer(),
});

/**
 * @deprecated Use DB.Tables.firmwareReleases to access this table.
 *
 * ESP32 firmware releases synced from GitHub; the files are in `<FIRMWARE_DIR>/<version>/`.
 */
export const firmwareReleases = sqliteTable("firmware_releases", {
	version: text().primaryKey(),
	prerelease: integer({ mode: "boolean" }).notNull(),
	published_at: integer().notNull(),
	release_url: text().notNull(),
	notes: text().notNull().default(""),
	// The release's release.json.
	manifest: text({ mode: "json" }).$type<FirmwareSettings.Manifest>().notNull(),
	// Whether firmware.sig was checked against FIRMWARE_PUBLIC_KEY.
	signature_verified: integer({ mode: "boolean" }).notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
});

/**
 * @deprecated Use DB.Tables.devices to access this table.
 */
export const devices = sqliteTable(
	"devices",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		owner_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		name: text().notNull(),
		type: text({ enum: DeviceSettings.Types }).notNull(),
		description: text().notNull().default(""),

		// Wake-on-LAN through `agent_id` (an agent in the same LAN).
		mac_address: text().notNull(),
		wol_port: integer().notNull().default(9),
		agent_id: integer().references(() => agents.id, { onDelete: "set null" }),

		status_method: text({ enum: DeviceSettings.StatusMethods }).notNull().default("none"),
		// IPv4/IPv6 address (or host name for `ssh`) checked by `ipv4`, `ipv6` and `ssh`.
		status_address: text(),
		// Optional TCP port probed in addition to the ping (e.g. 22, 445, 3389).
		status_tcp_port: integer(),

		// A Linux agent running on the device itself: reports its status and offers shutdown/reboot.
		host_agent_id: integer().references(() => agents.id, { onDelete: "set null" }),

		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [index("devices_owner_id_idx").on(table.owner_id)],
);

/**
 * @deprecated Use DB.Tables.deviceSshLogins to access this table.
 *
 * Where the device's agent logs in over SSH to shut the device down or reboot it. No secrets: the
 * agent logs in with its own keys (`agents.ssh_keys`). The SQL name is from 2.0.0, which
 * stored passwords and server-generated keys here.
 */
export const deviceSshLogins = sqliteTable("device_ssh_credentials", {
	device_id: integer()
		.primaryKey()
		.references(() => devices.id, { onDelete: "cascade" }),
	/** Host name or IP; null means the device's status address. */
	host: text(),
	port: integer().notNull().default(22),
	username: text().notNull(),
	os: text({ enum: DeviceSettings.SshOperatingSystems }).notNull().default("posix"),
	/** Run shutdown/reboot with `sudo -n` (POSIX, user isn't root). */
	sudo: integer({ mode: "boolean" }).notNull().default(true),
	/** The host key fingerprint the owner trusted (`SHA256:…`); null until confirmed. */
	host_key: text(),
	created_at: SQLUtils.getCreatedAtColumn(),
});

/**
 * @deprecated Use DB.Tables.deviceShares to access this table.
 */
export const deviceShares = sqliteTable(
	"device_shares",
	{
		device_id: integer()
			.notNull()
			.references(() => devices.id, { onDelete: "cascade" }),
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text({ enum: ShareSettings.Roles }).notNull(),
		created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [
		primaryKey({ columns: [table.device_id, table.user_id] }),
		index("device_shares_user_id_idx").on(table.user_id),
	],
);

/**
 * @deprecated Use DB.Tables.deviceFavorites to access this table.
 */
export const deviceFavorites = sqliteTable(
	"device_favorites",
	{
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		device_id: integer()
			.notNull()
			.references(() => devices.id, { onDelete: "cascade" }),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [primaryKey({ columns: [table.user_id, table.device_id] })],
);
