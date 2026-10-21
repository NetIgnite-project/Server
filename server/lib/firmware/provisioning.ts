import type { FirmwareSettings } from "../api/utils/shared-models/netigniteData";
import { NVSImage } from "./nvs";

/**
 * The NVS image the web installer flashes with the firmware: the server URL, a single-use
 * enrollment token and the agent's name. The agent enrolls with the token on its first connection
 * and generates its long-term secret itself, so the image holds nothing that stays valid.
 */
export class ProvisioningImage {
	static readonly REQUIRED_KEYS = ["server", "enroll"] as const;

	/** Whether the release's firmware reads its settings from an installer image. */
	static supports(manifest: FirmwareSettings.Manifest) {
		return this.REQUIRED_KEYS.every((key) => manifest.nvs.keys.includes(key));
	}

	/** Writes the values the firmware declares in `release.json` (`nvs.keys`), nothing else. */
	static build(manifest: FirmwareSettings.Manifest, values: ProvisioningImage.Values) {
		if (!this.supports(manifest)) {
			throw new Error(`Firmware ${manifest.version} can't be set up by the web installer`);
		}

		const entries: Record<string, NVSImage.Value> = {};
		const name = this.hostname(values.name);
		for (const [key, value] of Object.entries({ ...values, name })) {
			if (value && manifest.nvs.keys.includes(key)) entries[key] = { type: "string", value };
		}

		return NVSImage.generate([{ name: manifest.nvs.namespace, entries }], manifest.nvs.size);
	}

	/**
	 * The firmware uses its name as the network host name: letters, digits and `-`, at most 63
	 * characters. "Garage ESP32" becomes "Garage-ESP32"; an empty result keeps the firmware's default.
	 */
	static hostname(name: string) {
		return (
			name
				.normalize("NFKD")
				// Accents split off by NFKD: "Büro" → "Buro".
				.replace(/\p{M}/gu, "")
				.replace(/[^A-Za-z0-9-]+/g, "-")
				.replace(/-{2,}/g, "-")
				.slice(0, 63)
				.replace(/^-+|-+$/g, "")
		);
	}
}

export namespace ProvisioningImage {
	export interface Values {
		server: string;
		enroll: string;
		name: string;
	}
}
