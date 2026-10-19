import { createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";
import { DB } from "../../../../../db";
import { UserDataPolicies } from "../../../../utils/shared-models/accountData";

export namespace AccountModel.GetInfo {
	export const Response = createSelectSchema(DB.Tables.users).omit({
		password_hash: true,
	});
	export type Response = z.infer<typeof Response>;
}

export namespace AccountModel.UpdateInfo {
	export const Body = createUpdateSchema(DB.Tables.users, {
		username: UserDataPolicies.Username,
		email: z.email("Invalid email"),
	})
		.omit({
			id: true,
			password_hash: true,
			role: true,
			created_at: true,
		})
		.partial()
		.refine((data) => Object.values(data).some((value) => value !== undefined), {
			message: "At least one field must be provided",
		})
		.and(
			z.object({
				current_password: z
					.string()
					.min(1)
					.describe("Current password — required to confirm account changes"),
			}),
		);

	export type Body = z.infer<typeof Body>;
}

export namespace AccountModel.UpdatePassword {
	export const Body = z.object({
		current_password: z.string().describe("Current password of the account"),
		new_password: UserDataPolicies.Password,
	});

	export type Body = z.infer<typeof Body>;
}
