/**
 * Prepares an ESP Web Tools install: downloads the firmware's flash images from this server,
 * checks them against the release's SHA-256s and builds a manifest whose parts (including the
 * agent's NVS image with its enrollment token) are `blob:` URLs, so nothing secret ends up in a URL
 * the browser could cache or log.
 */
import type { GetFirmwareResponses } from "~/api-client";

export type FirmwareRelease = GetFirmwareResponses["200"]["data"]["releases"][number];

export interface PreparedInstall {
	version: string;
	/** Pass to `<esp-web-install-button manifest>`. */
	manifestURL: string;
	/** When the enrollment token in the NVS image expires. */
	expiresAt: number;
	/** Revokes the blob URLs. */
	dispose(): void;
}

async function sha256Hex(data: ArrayBuffer) {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function downloadFirmwarePart(
	apiBase: string,
	sessionToken: string | null,
	release: FirmwareRelease,
	part: FirmwareRelease["parts"][number],
) {
	const url = `${apiBase}/firmware/${encodeURIComponent(release.version)}/files/${encodeURIComponent(part.file)}`;
	const res = await fetch(url, {
		headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
	});
	if (!res.ok) throw new Error(`Downloading ${part.file} failed (${res.status})`);

	const data = await res.arrayBuffer();
	if (data.byteLength !== part.size || (await sha256Hex(data)) !== part.sha256) {
		throw new Error(`${part.file} arrived damaged. Try again.`);
	}
	return new Blob([data], { type: "application/octet-stream" });
}

export function createInstall(
	release: FirmwareRelease,
	parts: { blob: Blob; offset: number }[],
	expiresAt: number,
): PreparedInstall {
	const urls: string[] = [];
	const objectURL = (blob: Blob) => {
		const url = URL.createObjectURL(blob);
		urls.push(url);
		return url;
	};

	const manifest = {
		// Must equal the firmware's Improv name, so ESP Web Tools recognizes installed agents.
		name: "NetIgnite Agent",
		version: release.version,
		new_install_prompt_erase: true,
		builds: [
			{
				chipFamily: release.chip_family,
				parts: [...parts]
					.sort((a, b) => a.offset - b.offset)
					.map((part) => ({ path: objectURL(part.blob), offset: part.offset })),
			},
		],
	};

	return {
		version: release.version,
		manifestURL: objectURL(new Blob([JSON.stringify(manifest)], { type: "application/json" })),
		expiresAt,
		dispose() {
			for (const url of urls) URL.revokeObjectURL(url);
		},
	};
}

export function base64ToBlob(base64: string) {
	return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
		type: "application/octet-stream",
	});
}
