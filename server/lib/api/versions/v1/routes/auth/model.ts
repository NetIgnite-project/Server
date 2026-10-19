import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { DB } from "../../../../../db";
import { UserDataPolicies } from "../../../../utils/shared-models/accountData";

export namespace AuthModel.Login {
	export const Body = z.object({
		username: z.string(),
		password: z.string(),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = createSelectSchema(DB.Tables.sessions)
		.omit({
			id: true,
			hashed_token: true,
		})
		.extend({
			token: z.string(),
		});
	export type Response = z.infer<typeof Response>;
}

export namespace AuthModel.Session {
	export const Response = createSelectSchema(DB.Tables.sessions).omit({
		id: true,
		hashed_token: true,
	});
	export type Response = z.infer<typeof Response>;
}

export namespace AuthModel.Signup {
	export const Body = z.object({
		username: UserDataPolicies.Username,
		display_name: z.string().trim().min(1).max(64).optional(),
		email: z.email().trim(),
		password: z.string().min(8).max(128),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = AuthModel.Login.Response;
	export type Response = AuthModel.Login.Response;
}

export namespace AuthModel.Registration {
	export const Response = z.object({ enabled: z.boolean() });
	export type Response = z.infer<typeof Response>;
}
