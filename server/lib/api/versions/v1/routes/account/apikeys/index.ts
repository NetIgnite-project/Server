import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { Logger } from "../../../../../../utils/logger";
import { APIResponse } from "../../../../../utils/api-res";
import {
	APIKeyHandler,
	AuthHandler,
	AuthUtils,
	SessionHandler,
} from "../../../../../utils/authHandler";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AccountAPIKeysModel } from "./model";

export const router = new Hono().basePath("/apikeys");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get all API keys",
		description: "Retrieve all API keys for the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT_API_KEYS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"API keys retrieved successfully",
				AccountAPIKeysModel.GetById.Response.array(),
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const apiKeys = DB.instance()
			.select()
			.from(DB.Tables.apiKeys)
			.where(eq(DB.Tables.apiKeys.user_id, authContext.user_id))
			.all();

		const apiKeysWithoutSensitive = apiKeys.map((key) => ({
			id: key.id,
			description: key.description,
			created_at: key.created_at,
			expires_at: key.expires_at,
		}));

		return APIResponse.success(c, "API keys retrieved successfully", apiKeysWithoutSensitive);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create a new API key",
		description: "Create a new API key for the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT_API_KEYS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("API key created successfully", AccountAPIKeysModel.Create.Response),
		),
	}),

	validator("json", AccountAPIKeysModel.Create.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const apiKeyData = c.req.valid("json");

		let expirationInDays: number | undefined;

		switch (apiKeyData.expires_at) {
			case "7d":
				expirationInDays = 7;
				break;
			case "30d":
				expirationInDays = 30;
				break;
			case "90d":
				expirationInDays = 90;
				break;
			case "180d":
				expirationInDays = 180;
				break;
			case "365d":
				expirationInDays = 365;
				break;
			default:
				expirationInDays = undefined;
				break;
		}

		try {
			const key = await DB.instance().transaction(async (tx: DrizzleDB) => {
				return await APIKeyHandler.createApiKey(
					authContext.user_id,
					apiKeyData.description,
					expirationInDays,
					tx,
				);
			});

			const tokenID = AuthUtils.getTokenParts(key.token)?.id;

			if (!tokenID) {
				throw new Error("Failed to parse token ID from generated API key");
			}

			const keyWithoutSensitive = {
				id: tokenID,
				token: key.token,
			};

			return APIResponse.success(
				c,
				"API key created successfully",
				keyWithoutSensitive satisfies AccountAPIKeysModel.Create.Response,
			);
		} catch (error: any) {
			Logger.error("Failed to create API key", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to create API key");
		}
	},
);

router.use(
	"/:apiKeyID/*",

	validator(
		"param",
		z.object({
			apiKeyID: z.string().min(1).max(255),
		}),
	),

	async (c, next) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		// @ts-ignore
		const apiKeyID = (c.req.valid("param") as { apiKeyID: string }).apiKeyID;

		const apiKey = await DB.instance()
			.select()
			.from(DB.Tables.apiKeys)
			.where(
				and(eq(DB.Tables.apiKeys.id, apiKeyID), eq(DB.Tables.apiKeys.user_id, authContext.user_id)),
			)
			.get();

		if (!apiKey) {
			return APIResponse.notFound(c, "API key not found");
		}

		// @ts-ignore
		c.set("apiKey", apiKey);

		await next();
	},
);

router.get(
	"/:apiKeyID",

	APIRouteSpec.authenticated({
		summary: "Get API key details",
		description:
			"Retrieve details of a specific API key by its ID for the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT_API_KEYS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("API key retrieved successfully", AccountAPIKeysModel.GetById.Response),
			APIResponseSpec.notFound("API key not found"),
		),
	}),

	async (c) => {
		// @ts-ignore
		const apiKey = c.get("apiKey") as DB.Models.ApiKey;

		const apiKeyWithoutSensitive = {
			id: apiKey.id,
			description: apiKey.description,
			created_at: apiKey.created_at,
			expires_at: apiKey.expires_at,
		};

		return APIResponse.success(
			c,
			"API key retrieved successfully",
			apiKeyWithoutSensitive satisfies AccountAPIKeysModel.GetById.Response,
		);
	},
);

router.delete(
	"/:apiKeyID",

	APIRouteSpec.authenticated({
		summary: "Delete an API key",
		description: "Delete an API key by its ID for the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT_API_KEYS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("API key deleted successfully"),
			APIResponseSpec.notFound("API key not found"),
		),
	}),

	async (c) => {
		// @ts-ignore
		const apiKey = c.get("apiKey") as DB.Models.ApiKey;

		await APIKeyHandler.deleteApiKey(apiKey.id);

		return APIResponse.successNoData(c, "API key deleted successfully");
	},
);
