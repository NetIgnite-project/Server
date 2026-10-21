import { eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db/index";
import { FirmwareSettings } from "./shared-models/netigniteData";

export class RuntimeMetadata {
	protected static readonly schemas = {
		dummy: z.record(z.string(), z.any()).default({}),
		settings: z
			.object({
				/** Lets anyone create an account at /auth/signup. Off by default for self-hosted servers. */
				registration_enabled: z.boolean().default(false),
				/** Which ESP32 firmware releases the installer and OTA updates offer by default. */
				firmware_channel: FirmwareSettings.Channel.default("stable"),
				/**
				 * Shutdown and reboot over SSH through the device's agent. Off by default: the agent on the
				 * device itself is the safer way.
				 */
				ssh_enabled: z.boolean().default(false),
			})
			.default({ registration_enabled: false, firmware_channel: "stable", ssh_enabled: false }),
		/** Outcome of the last firmware release sync from GitHub. */
		firmware_sync: z
			.object({
				last_run_at: z.number().nullable().default(null),
				last_success_at: z.number().nullable().default(null),
				error: z.string().nullable().default(null),
			})
			.default({ last_run_at: null, last_success_at: null, error: null }),
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

	static getFirmwareSyncState() {
		return this.getMetadata("firmware_sync");
	}

	static setFirmwareSyncState(state: z.infer<(typeof this.schemas)["firmware_sync"]>) {
		return this.setMetadata("firmware_sync", state);
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
