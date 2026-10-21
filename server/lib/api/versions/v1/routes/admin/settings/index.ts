import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { APIResponse } from "../../../../../utils/api-res";
import { RuntimeMetadata } from "../../../../../utils/metadata";
import { FirmwareSettings } from "../../../../../utils/shared-models/netigniteData";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";

export const router = new Hono().basePath("/settings");

const Settings = z.object({
	registration_enabled: z.boolean(),
	/** Firmware releases the installer and OTA updates offer by default. */
	firmware_channel: FirmwareSettings.Channel,
	/** Shutdown and reboot over SSH through the device's agent (off by default). */
	ssh_enabled: z.boolean(),
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get server settings",
		tags: [DOCS_TAGS.ADMIN_API.SETTINGS],
		responses: APIResponseSpec.describeBasic(APIResponseSpec.success("Settings retrieved", Settings)),
	}),

	async (c) => APIResponse.success(c, "Settings retrieved", await RuntimeMetadata.getSettings()),
);

router.put(
	"/",

	APIRouteSpec.authenticated({
		summary: "Update server settings",
		tags: [DOCS_TAGS.ADMIN_API.SETTINGS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Settings updated", Settings),
		),
	}),

	validator("json", Settings.partial()),

	async (c) =>
		APIResponse.success(
			c,
			"Settings updated",
			await RuntimeMetadata.updateSettings(c.req.valid("json")),
		),
);
