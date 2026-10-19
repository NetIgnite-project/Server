import { z } from "zod";
import { UserPreferences } from "../../../../../utils/preferences";

export namespace AccountPreferencesModel.GetAll {
	export const Response = UserPreferences.allSchema;
	export type Response = z.infer<typeof Response>;
}

export namespace AccountPreferencesModel.Onboarding {
	export const Response = UserPreferences.schemas["onboarding"];
	export type Response = z.infer<typeof Response>;

	export const Body = Response;
	export type Body = z.infer<typeof Body>;
}
