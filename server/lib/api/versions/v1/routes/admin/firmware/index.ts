import { Hono } from "hono";
import z from "zod";
import { FirmwareCatalog } from "../../../../../../firmware/catalog";
import { ConfigHandler } from "../../../../../../utils/config";
import { APIResponse } from "../../../../../utils/api-res";
import { RuntimeMetadata } from "../../../../../utils/metadata";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";

export const router = new Hono().basePath("/firmware");

const SyncState = z.object({
	/** Automatic sync (FIRMWARE_SYNC); a manual sync works either way. */
	enabled: z.boolean(),
	repo: z.string(),
	/** Whether FIRMWARE_PUBLIC_KEY is set, so only signed releases are accepted. */
	signature_required: z.boolean(),
	last_run_at: z.number().nullable(),
	last_success_at: z.number().nullable(),
	error: z.string().nullable(),
});

const SyncResult = z.object({
	added: z.array(z.string()),
	removed: z.array(z.string()),
	skipped: z.array(z.object({ version: z.string(), reason: z.string() })),
	state: SyncState,
});

async function getState(): Promise<z.infer<typeof SyncState>> {
	const config = ConfigHandler.getConfig();
	return {
		enabled: config?.FIRMWARE_SYNC ?? false,
		repo: config?.FIRMWARE_REPO ?? "",
		signature_required: Boolean(config?.FIRMWARE_PUBLIC_KEY),
		...(await RuntimeMetadata.getFirmwareSyncState()),
	};
}

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get the firmware sync state",
		tags: [DOCS_TAGS.ADMIN_API.FIRMWARE],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Sync state retrieved", SyncState),
		),
	}),

	async (c) => APIResponse.success(c, "Sync state retrieved", await getState()),
);

router.post(
	"/sync",

	APIRouteSpec.authenticated({
		summary: "Sync firmware releases now",
		description: "Checks GitHub for new firmware releases and downloads them.",
		tags: [DOCS_TAGS.ADMIN_API.FIRMWARE],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Sync finished", SyncResult),
			APIResponseSpec.badGateway("GitHub couldn't be reached or answered with an error"),
		),
	}),

	async (c) => {
		const result = await FirmwareCatalog.sync();
		if (result.error) return APIResponse.badGateway(c, result.error);

		return APIResponse.success(c, "Sync finished", {
			added: result.added,
			removed: result.removed,
			skipped: result.skipped,
			state: await getState(),
		} satisfies z.infer<typeof SyncResult>);
	},
);
