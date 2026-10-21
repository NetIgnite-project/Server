import { Hono } from "hono";
import { validator } from "hono-openapi";
import { AgentAuth } from "../../../../../agents/auth";
import type { DB } from "../../../../../db";
import { FirmwareCatalog } from "../../../../../firmware/catalog";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";
import { RuntimeMetadata } from "../../../../utils/metadata";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { FirmwareModel } from "./model";

export const router = new Hono().basePath("/firmware");

// Users (the web installer), and ESP32 agents downloading an OTA update with their own credential.
router.use("*", async (c, next) => {
	if (AuthHandler.AuthContext.get(c).type !== "unauthenticated") return await next();

	const header = c.req.header("Authorization");
	const isFileDownload = c.req.method === "GET" && /\/files\/[^/]+$/.test(c.req.path);
	if (isFileDownload && header?.startsWith(`Bearer ${AgentAuth.AGENT_TOKEN_PREFIX}`)) {
		const agent = await AgentAuth.authenticate(header.slice("Bearer ".length).trim());
		if (agent?.kind === "esp32") return await next();
	}
	return APIResponse.unauthorized(c, "Authentication required");
});

export function toReleaseResponse(release: DB.Models.FirmwareRelease): FirmwareModel.Release {
	return {
		version: release.version,
		prerelease: release.prerelease,
		published_at: release.published_at,
		release_url: release.release_url,
		notes: release.notes,
		signature_verified: release.signature_verified,
		chip_family: release.manifest.chip_family,
		parts: release.manifest.parts,
		nvs_offset: release.manifest.nvs.offset,
	};
}

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List firmware releases",
		description:
			"ESP32 firmware releases available for the web installer and OTA updates, newest first. They " +
			"are synced from the GitHub releases of the Agent-ESP32 repository.",
		tags: [DOCS_TAGS.FIRMWARE],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Firmware releases retrieved", FirmwareModel.Catalog),
		),
	}),

	async (c) => {
		const releases = await FirmwareCatalog.list();
		const { firmware_channel } = await RuntimeMetadata.getSettings();

		return APIResponse.success(c, "Firmware releases retrieved", {
			channel: firmware_channel,
			recommended: FirmwareCatalog.recommended(releases, firmware_channel)?.version ?? null,
			releases: releases.map(toReleaseResponse),
		} satisfies FirmwareModel.Catalog);
	},
);

router.get(
	"/:version/files/:file",

	APIRouteSpec.authenticated({
		summary: "Download a firmware file",
		description:
			"A flash image (or the signature) of a synced release, for the web installer. ESP32 agents " +
			"download OTA updates here with their agent credential.",
		tags: [DOCS_TAGS.FIRMWARE],
		responses: {
			200: {
				description: "The file",
				content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
			},
			...APIResponseSpec.notFound("Unknown release or file"),
		},
	}),

	validator("param", FirmwareModel.FileParams),

	async (c) => {
		const { version, file } = c.req.valid("param");

		const release = await FirmwareCatalog.get(version);
		const filePath = release && FirmwareCatalog.filePath(release, file);
		const data = filePath ? Bun.file(filePath) : null;
		if (!data || !(await data.exists())) {
			return APIResponse.notFound(c, "Unknown release or file");
		}

		return new Response(data, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(data.size),
				"Content-Disposition": `attachment; filename="${version}-${file}"`,
				// A version's files never change.
				"Cache-Control": "private, max-age=31536000, immutable",
			},
		});
	},
);
