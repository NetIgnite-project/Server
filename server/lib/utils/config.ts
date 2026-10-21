import { z } from "zod";
import { AppConstants } from "./constants";
import { Logger } from "./logger";

interface ConfigSchemaSettings {
	[key: string]: CS.ConfigItem<z.ZodType>;
}

type ConfigLike<T extends ConfigSchemaSettings> = {
	[K in keyof T]: z.infer<T[K]["_schema"]>;
};

class CS {
	private constructor() {}

	static string() {
		return new CS.ConfigItem(z.string());
	}

	static number() {
		return new CS.ConfigItem(z.coerce.number());
	}

	static boolean() {
		return new CS.ConfigItem(
			z.union(
				[
					z.boolean(),
					z
						.string()
						.refine((val) => val === "true" || val === "false")
						.transform((val) => val === "true"),
				],
				{ error: "Expected a boolean value ('true' or 'false')" },
			),
		);
	}

	static enum<const T extends readonly string[]>(values: T) {
		return new CS.ConfigItem(z.enum(values));
	}

	static array() {
		return new CS.ConfigItem(
			z.string().transform<string[]>((val) => {
				if (typeof val === "string") {
					return val
						.split(",")
						.map((v) => v.trim())
						.filter(Boolean);
				}
				return [];
			}),
		);
	}
}

namespace CS {
	export class ConfigItem<const Schema extends z.ZodType> {
		constructor(public _schema: Schema) {}

		public parse(value: unknown) {
			return this._schema.safeParse(value);
		}

		public default(value: z.util.NoUndefined<z.core.output<Schema>>) {
			this._schema = this._schema.default(value) as any;
			return this as any as ConfigItem<z.ZodDefault<Schema>>;
		}

		public optional() {
			this._schema = this._schema.optional() as any;
			return this as any as ConfigItem<z.ZodOptional<Schema>>;
		}
	}
}

class ConfigSchema<T extends ConfigSchemaSettings> {
	readonly schema: T;

	constructor(schema: T) {
		this.schema = schema;
	}

	public parse() {
		const result: ConfigLike<T> = {} as ConfigLike<T>;

		for (const [key, settings] of Object.entries(this.schema)) {
			const value = process.env[`${AppConstants.APP_ENV_PREFIX}_${key}`];

			const parseResult = settings.parse(value);
			if (!parseResult.success) {
				Logger.error(
					`Failed to read the environment variable ${key}: ${parseResult.error.issues[0]?.message}`,
				);
				process.exit(1);
			}

			// Store the parsed (coerced/defaulted) value, not the raw env string —
			// otherwise numbers/booleans stay strings and defaults/optionals are lost.
			(result[key] as any) = parseResult.data;
		}
		return result;
	}
}

export type ENVConfigLike = {
	[K in Extract<
		keyof typeof ConfigHandler.schema.schema,
		string
	> as `${typeof AppConstants.APP_ENV_PREFIX}_${K}`]: z.infer<
		(typeof ConfigHandler.schema.schema)[K]["_schema"]
	>;
};

export type ParsedConfig = ConfigLike<typeof ConfigHandler.schema.schema>;

export class ConfigHandler {
	// Public so ENVConfigLike / ParsedConfig can derive from it without @ts-ignore.
	// Treat it as read-only.
	static schema = new ConfigSchema({
		LOG_LEVEL: CS.enum(["debug", "info", "warn", "error", "critical"]).default("info"),

		API_DISABLE_DOCS: CS.boolean().default(false),

		DB_PATH: CS.string().default("./data/netignite.sqlite"),
		DB_AUTO_MIGRATE: CS.boolean().default(true),
		DB_MIGRATION_DIR: CS.string().default("./drizzle/migrations"),

		LOG_DIR: CS.string().default("./data/logs"),
		CONFIG_BASE_DIR: CS.string().default("./config"),

		APP_URL: CS.string(),

		// Encrypts SSH credentials in the database. Default: a key generated in CONFIG_BASE_DIR/secrets.key.
		SECRETS_KEY: CS.string().optional(),

		// ESP32 firmware for the web installer and OTA updates, synced from the GitHub releases of
		// FIRMWARE_REPO. FIRMWARE_PUBLIC_KEY: path to a PEM ECDSA P-256 public key; when set, only
		// releases with a valid firmware.sig are accepted.
		FIRMWARE_SYNC: CS.boolean().default(true),
		FIRMWARE_REPO: CS.string().default("NetIgnite-project/Agent-ESP32"),
		FIRMWARE_DIR: CS.string().default("./data/firmware"),
		FIRMWARE_PUBLIC_KEY: CS.string().optional(),
		/** Optional; raises GitHub's API rate limit for the release sync. */
		GITHUB_TOKEN: CS.string().optional(),

		// The Linux agent's install script (/install/linux.sh) downloads the agent from the GitHub
		// releases of LINUX_AGENT_REPO: the release tagged LINUX_AGENT_VERSION (e.g. v1.0.0), or the
		// newest release, pre-releases included.
		LINUX_AGENT_REPO: CS.string().default("NetIgnite-project/Agent-Linux"),
		LINUX_AGENT_VERSION: CS.string().optional(),

		SMTP_HOST: CS.string().optional(),
		SMTP_PORT: CS.number().optional(),
		SMTP_USERNAME: CS.string().optional(),
		SMTP_PASSWORD: CS.string().optional(),
		SMTP_FROM: CS.string().optional(),
		SMTP_SECURE: CS.boolean().optional(),
	});

	private static config: ParsedConfig | null = null;

	/** You have to call {@link ConfigHandler.loadConfig} before trying to access the config. */
	static getConfig() {
		return this.config;
	}

	static async loadConfig() {
		if (this.config) return this.config;
		this.config = this.schema.parse();
		return this.config;
	}
}
