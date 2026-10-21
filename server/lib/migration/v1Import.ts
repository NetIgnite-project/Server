import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { RuntimeMetadata } from "../api/utils/metadata";
import { DeviceSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";

/** A synchronous bun-sqlite transaction. */
type SyncTx = Parameters<Parameters<ReturnType<typeof DB.instance>["transaction"]>[0]>[0];

type V1User = {
	id: number;
	username: string;
	password_hash: string;
	role: string;
	favorites: string;
};
type V1Agent = { id: number; name: string; type: string; description: string; ownerID: number };
type V1Device = {
	id: number;
	name: string;
	type: string;
	description: string | null;
	macAddress: string;
	port: number;
	agentID: number;
	ownerID: number;
};

export type V1ImportReport = {
	dryRun: boolean;
	users: { imported: string[]; merged: string[]; skipped: { username: string; reason: string }[] };
	agents: { imported: number; skipped: { name: string; reason: string }[] };
	devices: { imported: number; skipped: { name: string; reason: string }[] };
	favorites: number;
};

/**
 * Imports users, agents and devices from a NetIgnite v1 database (`data/db.sqlite`).
 *
 * - Users keep their bcrypt password hash (upgraded to argon2id at their next login) and get a
 *   placeholder email address, which the `/welcome` onboarding asks them to change.
 * - The v1 `admin` is merged into the v2 server's initial `admin`; with `mergeUsers`, every v1 user
 *   whose username already exists in v2 is merged. A merged account takes over the v1 password
 *   only if nobody has logged into it in v2 yet.
 * - Agents are imported unenrolled: v1 credentials can't be used in v2, so each agent is set up
 *   again (ESP32: flash the v2 firmware; Linux: `netignite-agent pair`).
 * - Devices keep MAC address, port and agent, and use the `link_local` status check like v1.
 *
 * Idempotent: v1 → v2 ids are stored in the `v1_import` metadata and imported rows are skipped
 * the next time.
 */
export class V1Importer {
	static readonly PLACEHOLDER_EMAIL_DOMAIN = "imported.netignite.invalid";

	/**
	 * The v1 database (`db.sqlite`) next to the v2 database at `databasePath`, if it exists and
	 * nothing was imported from it yet; otherwise null. A v1 server that pulled a v2 image starts
	 * with an empty v2 database, and its users' data is still in that file.
	 */
	static async pendingV1Database(databasePath: string): Promise<string | null> {
		const v1Path = join(dirname(databasePath), "db.sqlite");
		if (resolve(v1Path) === resolve(databasePath) || !existsSync(v1Path)) return null;
		const state = await RuntimeMetadata.getV1ImportState();
		return Object.keys(state.users).length === 0 ? v1Path : null;
	}

	static async run(options: {
		sourcePath: string;
		dryRun?: boolean;
		configBaseDir?: string;
		/** Merge v1 users into existing v2 users with the same username (not just `admin`). */
		mergeUsers?: boolean;
	}): Promise<V1ImportReport> {
		const dryRun = options.dryRun ?? false;
		const report: V1ImportReport = {
			dryRun,
			users: { imported: [], merged: [], skipped: [] },
			agents: { imported: 0, skipped: [] },
			devices: { imported: 0, skipped: [] },
			favorites: 0,
		};

		if (!existsSync(options.sourcePath)) {
			throw new Error(`v1 database not found: ${options.sourcePath}`);
		}

		const source = new Database(options.sourcePath, { readonly: true });
		try {
			const tables = new Set(
				(
					source.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
				).map((row) => row.name),
			);
			for (const table of ["users", "agents", "devices"]) {
				if (!tables.has(table))
					throw new Error(`Not a NetIgnite v1 database: table "${table}" is missing`);
			}

			const v1Users = source.query("SELECT * FROM users ORDER BY id").all() as V1User[];
			const v1Agents = source.query("SELECT * FROM agents ORDER BY id").all() as V1Agent[];
			const v1Devices = source.query("SELECT * FROM devices ORDER BY id").all() as V1Device[];

			// Cloned: a missing metadata key reads as a shared default object, which must not be mutated.
			const state = structuredClone(await RuntimeMetadata.getV1ImportState());
			const db = DB.instance();
			let adminPasswordTakenOver = false;

			// Synchronous on purpose: drizzle's bun-sqlite transaction() commits at the first `await`.
			const work = (tx: SyncTx) => {
				// --- Users ---
				for (const v1 of v1Users) {
					if (state.users[v1.id] !== undefined) continue;

					const role = v1.role === "admin" ? "admin" : "user";
					const existing = tx
						.select()
						.from(DB.Tables.users)
						.where(eq(DB.Tables.users.username, v1.username))
						.get();

					if (existing) {
						if (!this.isInitialAdmin(existing) && !options.mergeUsers) {
							report.users.skipped.push({
								username: v1.username,
								reason: "username already exists in v2 (use --merge-users to merge them)",
							});
							continue;
						}

						if (this.passwordNeverSet(tx, existing)) {
							adminPasswordTakenOver = true;
							tx
								.update(DB.Tables.users)
								.set({ password_hash: v1.password_hash, role })
								.where(eq(DB.Tables.users.id, existing.id))
								.run();
							// Its password-reset link would otherwise still let anyone with the file set a password.
							tx
								.delete(DB.Tables.passwordResets)
								.where(eq(DB.Tables.passwordResets.user_id, existing.id))
								.run();
						}
						state.users[v1.id] = existing.id;
						report.users.merged.push(v1.username);
						continue;
					}

					const user = tx
						.insert(DB.Tables.users)
						.values({
							username: v1.username,
							display_name: v1.username,
							email: `${v1.username}@${this.PLACEHOLDER_EMAIL_DOMAIN}`,
							password_hash: v1.password_hash,
							role,
						})
						.returning()
						.get();
					state.users[v1.id] = user.id;
					report.users.imported.push(v1.username);
				}

				// --- Agents ---
				for (const v1 of v1Agents) {
					if (state.agents[v1.id] !== undefined) continue;

					const ownerID = state.users[v1.ownerID];
					if (ownerID === undefined) {
						report.agents.skipped.push({ name: v1.name, reason: "owner wasn't imported" });
						continue;
					}

					const agent = tx
						.insert(DB.Tables.agents)
						.values({
							owner_id: ownerID,
							name: v1.name.slice(0, 64) || `Agent ${v1.id}`,
							description: (v1.description ?? "").slice(0, 500),
							kind: v1.type === "server" ? "linux" : "esp32",
						})
						.returning()
						.get();
					state.agents[v1.id] = agent.id;
					report.agents.imported += 1;
				}

				// --- Devices ---
				for (const v1 of v1Devices) {
					if (state.devices[v1.id] !== undefined) continue;

					const ownerID = state.users[v1.ownerID];
					if (ownerID === undefined) {
						report.devices.skipped.push({ name: v1.name, reason: "owner wasn't imported" });
						continue;
					}

					const mac = DeviceSettings.MacAddress.safeParse(v1.macAddress);
					if (!mac.success) {
						report.devices.skipped.push({
							name: v1.name,
							reason: `invalid MAC address "${v1.macAddress}"`,
						});
						continue;
					}

					const agentID = state.agents[v1.agentID] ?? null;
					const type = DeviceSettings.Type.safeParse(v1.type);

					const device = tx
						.insert(DB.Tables.devices)
						.values({
							owner_id: ownerID,
							name: v1.name.slice(0, 64) || `Device ${v1.id}`,
							type: type.success ? type.data : "other",
							description: (v1.description ?? "").slice(0, 500),
							mac_address: mac.data,
							wol_port: v1.port >= 1 && v1.port <= 65535 ? v1.port : 9,
							// Only an agent of the same owner may wake the device.
							agent_id: agentID !== null && this.agentOwner(tx, agentID) === ownerID ? agentID : null,
							status_method: agentID !== null ? "link_local" : "none",
						})
						.returning()
						.get();
					state.devices[v1.id] = device.id;
					report.devices.imported += 1;
				}

				// --- Favorites ---
				for (const v1 of v1Users) {
					const userID = state.users[v1.id];
					if (userID === undefined) continue;

					for (const v1DeviceID of this.parseFavorites(v1.favorites)) {
						const deviceID = state.devices[v1DeviceID];
						if (deviceID === undefined) continue;

						const inserted = tx
							.insert(DB.Tables.deviceFavorites)
							.values({ user_id: userID, device_id: deviceID })
							.onConflictDoNothing()
							.returning()
							.get();
						if (inserted) report.favorites += 1;
					}
				}

				if (!dryRun) {
					tx
						.insert(DB.Tables.metadata)
						.values({ key: "v1_import", data: state })
						.onConflictDoUpdate({ target: DB.Tables.metadata.key, set: { data: state } })
						.run();
				}
			};

			if (dryRun) {
				// Run everything, then roll back.
				try {
					db.transaction((tx) => {
						work(tx);
						throw new DryRunRollback();
					});
				} catch (error) {
					if (!(error instanceof DryRunRollback)) throw error;
				}
			} else {
				db.transaction((tx) => work(tx));

				// The initial admin now has the v1 password; its password-reset link is void.
				if (adminPasswordTakenOver && options.configBaseDir) {
					const tokenFile = join(options.configBaseDir, "initial_admin_password_reset_token.txt");
					if (existsSync(tokenFile)) rmSync(tokenFile);
				}
			}
		} finally {
			source.close();
		}

		return report;
	}

	/** The admin DB.init creates on an empty database. */
	private static isInitialAdmin(user: DB.Models.User) {
		return user.username === "admin" && user.display_name === "Default Administrator";
	}

	/**
	 * The initial admin whose password nobody has set yet: its password-reset link (from DB.init)
	 * is still unused. Only then does it take over the v1 admin's password.
	 */
	private static passwordNeverSet(tx: SyncTx, user: DB.Models.User) {
		return (
			this.isInitialAdmin(user) &&
			!!tx
				.select()
				.from(DB.Tables.passwordResets)
				.where(eq(DB.Tables.passwordResets.user_id, user.id))
				.get()
		);
	}

	private static agentOwner(tx: SyncTx, agentID: number) {
		const agent = tx
			.select({ owner_id: DB.Tables.agents.owner_id })
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.id, agentID))
			.get();
		return agent?.owner_id ?? null;
	}

	private static parseFavorites(raw: string | null): number[] {
		try {
			const parsed = JSON.parse(raw || "[]");
			return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
		} catch {
			return [];
		}
	}
}

class DryRunRollback extends Error {}
