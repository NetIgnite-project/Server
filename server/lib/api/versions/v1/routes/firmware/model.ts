import { z } from "zod";
import { FirmwareSettings } from "../../../../utils/shared-models/netigniteData";

export namespace FirmwareModel {
	export const Release = z.object({
		version: z.string(),
		prerelease: z.boolean(),
		published_at: z.number(),
		release_url: z.string(),
		notes: z.string(),
		/** Whether the app image's signature was checked against the server's public key. */
		signature_verified: z.boolean(),
		chip_family: z.string(),
		/** Flash images with their offsets; download them from `/firmware/<version>/files/<file>`. */
		parts: z.array(
			z.object({
				file: z.string(),
				offset: z.number(),
				size: z.number(),
				sha256: z.string(),
			}),
		),
		/** Where the installer writes the agent's provisioning data. */
		nvs_offset: z.number(),
	});
	export type Release = z.infer<typeof Release>;

	export const Catalog = z.object({
		channel: FirmwareSettings.Channel,
		/** The newest release of the channel; null if there is none. */
		recommended: z.string().nullable(),
		releases: z.array(Release),
	});
	export type Catalog = z.infer<typeof Catalog>;

	export const FileParams = z.object({
		version: FirmwareSettings.Version,
		file: z.string().regex(/^[A-Za-z0-9_.-]+$/),
	});
}
