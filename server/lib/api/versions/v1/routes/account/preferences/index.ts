import { Hono } from "hono";
import { validator } from "hono-openapi";
import { APIResponse } from "../../../../../utils/api-res";
import { AuthHandler } from "../../../../../utils/authHandler";
import { UserPreferencesHandler } from "../../../../../utils/preferences";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AccountPreferencesModel } from "./model";

export const router = new Hono().basePath("/preferences");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get all preferences",
		description:
			"Retrieve all of the authenticated user's preferences in a single request, keyed by the same names as the per-preference routes. Preferences that were never set are returned with their defaults.",
		tags: [DOCS_TAGS.ACCOUNT_PREFERENCES],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Preferences retrieved successfully",
				AccountPreferencesModel.GetAll.Response,
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const preferences = await UserPreferencesHandler.getAll(authContext.user_id);

		return APIResponse.success(c, "Preferences retrieved successfully", preferences);
	},
);

router.get(
	"/onboarding",

	APIRouteSpec.authenticated({
		summary: "Get onboarding state",
		description:
			"Retrieve whether the authenticated user has completed the one-time, platform-wide welcome onboarding.",
		tags: [DOCS_TAGS.ACCOUNT_PREFERENCES],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Onboarding state retrieved successfully",
				AccountPreferencesModel.Onboarding.Response,
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const preference = await UserPreferencesHandler.getOnboarding(authContext.user_id);

		return APIResponse.success(c, "Onboarding state retrieved successfully", preference);
	},
);

router.put(
	"/onboarding",

	APIRouteSpec.authenticated({
		summary: "Update onboarding state",
		description:
			"Set whether the authenticated user has completed the one-time, platform-wide welcome onboarding.",
		tags: [DOCS_TAGS.ACCOUNT_PREFERENCES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Onboarding state updated successfully"),
		),
	}),

	validator("json", AccountPreferencesModel.Onboarding.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const body = c.req.valid("json");

		await UserPreferencesHandler.setOnboarding(authContext.user_id, body);

		return APIResponse.successNoData(c, "Onboarding state updated successfully");
	},
);
