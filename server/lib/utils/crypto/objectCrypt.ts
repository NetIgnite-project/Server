import { Uint } from "low-level";
import { LCrypt } from "./lcrypt";

export class ObjectEncryption {
	static encrypt<T extends object>(obj: T, key: string): string {
		const keyHash = LCrypt.sha256(Uint.from(key, "utf8"));
		const serializableData = this.extractData(obj);
		const jsonString = JSON.stringify(serializableData);
		const data = Uint.from(jsonString, "utf8");

		return LCrypt.encryptData(data, keyHash).toHex();
	}

	static decrypt<T extends object>(encryptedHex: string, key: string): T {
		const keyHash = LCrypt.sha256(Uint.from(key, "utf8"));

		const encryptedData = Uint.from(encryptedHex, "hex");
		const decryptedData = LCrypt.decryptData(encryptedData, keyHash);
		const jsonString = decryptedData.toString("utf8");

		return JSON.parse(jsonString) as T;
	}

	private static extractData<T extends object>(obj: T): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		const allKeys = [
			...Object.keys(obj),
			...Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {}),
		];

		for (const field of allKeys) {
			if (field === "constructor") continue;

			try {
				const value = (obj as any)[field];
				if (typeof value === "function") continue;

				JSON.stringify(value);
				result[field] = value;
			} catch {
				// Skip non-serializable fields
			}
		}

		return result;
	}
}
