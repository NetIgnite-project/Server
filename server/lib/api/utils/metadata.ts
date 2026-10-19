import { eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db/index";

export class RuntimeMetadata {
	protected static readonly schemas = {
		dummy: z.record(z.string(), z.any()).default({}),
		settings: z
			.object({
				/** Lets anyone create an account at /auth/signup. Off by default for self-hosted servers. */
				registration_enabled: z.boolean().default(false),
			})
			.default({ registration_enabled: false }),
		/** v1 id → v2 id of everything imported by `import-v1`, so re-running it skips them. */
		v1_import: z
			.object({
				users: z.record(z.string(), z.number()).default({}),
				agents: z.record(z.string(), z.number()).default({}),
				devices: z.record(z.string(), z.number()).default({}),
			})
			.default({ users: {}, agents: {}, devices: {} }),
	} as const;

	static getV1ImportState() {
		return this.getMetadata("v1_import");
	}

	static setV1ImportState(state: z.infer<(typeof this.schemas)["v1_import"]>) {
		return this.setMetadata("v1_import", state);
	}

	static getSettings() {
		return this.getMetadata("settings");
	}

	static async updateSettings(update: Partial<z.infer<(typeof this.schemas)["settings"]>>) {
		const settings = { ...(await this.getSettings()), ...update };
		await this.setMetadata("settings", settings);
		return settings;
	}

	/** A key without a stored row reads as its schema default; nothing is written. */
	protected static getMetadata<T extends keyof typeof this.schemas>(
		key: T,
	): Promise<z.infer<(typeof this.schemas)[T]>>;
	/**
	 * @deprecated Call `getMetadata(key)`: a missing key then reads as its schema default. With
	 * `createIfNotFound`, a missing key is still written with its default (`true`) or throws (`false`).
	 */
	protected static getMetadata<T extends keyof typeof this.schemas>(
		key: T,
		createIfNotFound: boolean,
	): Promise<z.infer<(typeof this.schemas)[T]>>;
	protected static async getMetadata<T extends keyof typeof this.schemas>(
		key: T,
		createIfNotFound?: boolean,
	): Promise<z.infer<(typeof this.schemas)[T]>> {
		const record = await DB.instance()
			.select()
			.from(DB.Tables.metadata)
			.where(eq(DB.Tables.metadata.key, key))
			.get();

		// Indexing the heterogeneous `schemas` record by the generic key widens the
		// parse result to a union, so narrow it back to this key's inferred type.
		type Parsed = z.infer<(typeof this.schemas)[T]>;

		if (!record && createIfNotFound !== undefined) {
			if (!createIfNotFound) {
				throw new Error(`Metadata with key '${key}' not found`);
			}

			const defaultData = this.schemas[key].parse(undefined) as Parsed;
			await this.setMetadata(key, defaultData);
			return defaultData;
		}

		return this.schemas[key].parse(record?.data) as Parsed;
	}

	protected static async setMetadata<T extends keyof typeof this.schemas>(
		key: T,
		data: z.infer<(typeof this.schemas)[T]>,
	): Promise<void> {
		const parsed = this.schemas[key].parse(data);

		await DB.instance()
			.insert(DB.Tables.metadata)
			.values({ key, data: parsed })
			.onConflictDoUpdate({
				target: DB.Tables.metadata.key,
				set: { data: parsed },
			});
	}
}
