import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";

export namespace UserPreferences {
	// Each preference key maps to a fixed zod schema, so clients can't store
	// arbitrary data. Add new keys here, then expose typed getters/setters below.
	export const schemas = {
		onboarding: z.object({
			// Whether the user has completed the one-time, platform-wide welcome
			// onboarding (preferences setup). Drives the first-login redirect,
			// so it defaults to false until the user finishes or skips it.
			completed: z.boolean().default(false),
		}),
	} as const;

	export type Key = keyof typeof schemas;

	// Every preference at once, keyed by preference key. Derived from `schemas`
	// so newly added preferences are included automatically.
	export const allSchema = z.object(schemas);
	export type All = z.infer<typeof allSchema>;
}

/**
 * Per-user key/value preference storage (e.g. remote email content policy),
 * mirroring `RuntimeMetadata` but scoped to `user_id` instead of being global.
 * Each key has a fixed zod schema so clients cannot store arbitrary data.
 */
export class UserPreferencesHandler {
	static async get<T extends UserPreferences.Key>(
		userID: number,
		key: T,
		tx: DrizzleDB = DB.instance(),
	): Promise<z.infer<(typeof UserPreferences.schemas)[T]>> {
		const record = await tx
			.select()
			.from(DB.Tables.userPreferences)
			.where(
				and(eq(DB.Tables.userPreferences.user_id, userID), eq(DB.Tables.userPreferences.key, key)),
			)
			.get();

		// Indexing the heterogeneous `schemas` record by the generic key widens the
		// parse result to a union, so narrow it back to this key's inferred type.
		type Parsed = z.infer<(typeof UserPreferences.schemas)[T]>;

		if (!record) {
			// schemas[key] has per-field (not top-level) defaults, so it must be
			// parsed against `{}` rather than `undefined` to fill them in.
			return UserPreferences.schemas[key].parse({}) as Parsed;
		}

		return UserPreferences.schemas[key].parse(record.data) as Parsed;
	}

	/**
	 * Fetch every preference in a single query. Keys without a stored row are
	 * filled with their defaults, and stored keys no longer in `schemas` are dropped.
	 */
	static async getAll(userID: number, tx: DrizzleDB = DB.instance()): Promise<UserPreferences.All> {
		const records = await tx
			.select()
			.from(DB.Tables.userPreferences)
			.where(eq(DB.Tables.userPreferences.user_id, userID))
			.all();

		const stored = new Map(records.map((record) => [record.key, record.data]));

		// Same `{}` fallback as `get`, since the defaults are per-field.
		const raw = Object.fromEntries(
			Object.keys(UserPreferences.schemas).map((key) => [key, stored.get(key) ?? {}]),
		);

		return UserPreferences.allSchema.parse(raw);
	}

	static async set<T extends UserPreferences.Key>(
		userID: number,
		key: T,
		data: z.infer<(typeof UserPreferences.schemas)[T]>,
		tx: DrizzleDB = DB.instance(),
	): Promise<void> {
		const parsed = UserPreferences.schemas[key].parse(data);

		await tx
			.insert(DB.Tables.userPreferences)
			.values({
				user_id: userID,
				key,
				data: parsed,
			})
			.onConflictDoUpdate({
				target: [DB.Tables.userPreferences.user_id, DB.Tables.userPreferences.key],
				set: { data: parsed },
			});
	}

	static async getOnboarding(userID: number) {
		return this.get(userID, "onboarding");
	}

	static async setOnboarding(
		userID: number,
		data: z.infer<(typeof UserPreferences.schemas)["onboarding"]>,
	) {
		await this.set(userID, "onboarding", data);
	}

	static async deleteAllForUser(userID: number, tx: DrizzleDB = DB.instance()): Promise<void> {
		await tx.delete(DB.Tables.userPreferences).where(eq(DB.Tables.userPreferences.user_id, userID));
	}
}
