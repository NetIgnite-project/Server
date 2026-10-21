import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigHandler } from "./config";
import { ObjectEncryption } from "./crypto/objectCrypt";

/**
 * Encrypts secrets stored in the database (SSH passwords and private keys) with the server's
 * secrets key: NETIGNITE_SECRETS_KEY, or a key generated on first use in
 * `<NETIGNITE_CONFIG_BASE_DIR>/secrets.key`. Without that key, stored secrets can't be decrypted,
 * so back it up with the database.
 */
export class Secrets {
	static readonly KEY_FILE = "secrets.key";

	private static key: string | null = null;

	static encrypt(value: string) {
		return ObjectEncryption.encrypt({ value }, this.getKey());
	}

	static decrypt(encrypted: string) {
		return ObjectEncryption.decrypt<{ value: string }>(encrypted, this.getKey()).value;
	}

	/** For tests. */
	static reset() {
		this.key = null;
	}

	private static getKey() {
		if (this.key) return this.key;

		const config = ConfigHandler.getConfig();
		if (config?.SECRETS_KEY) {
			this.key = config.SECRETS_KEY;
			return this.key;
		}

		const file = path.join(config?.CONFIG_BASE_DIR ?? "./config", this.KEY_FILE);
		if (fs.existsSync(file)) {
			this.key = fs.readFileSync(file, "utf8").trim();
		} else {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const key = randomBytes(32).toString("hex");
			// `wx`: never overwrite a key another process wrote meanwhile.
			try {
				fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
				this.key = key;
			} catch {
				this.key = fs.readFileSync(file, "utf8").trim();
			}
		}
		if (!this.key) throw new Error(`The secrets key in ${file} is empty`);
		return this.key;
	}
}
