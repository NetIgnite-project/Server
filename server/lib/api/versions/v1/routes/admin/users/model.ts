import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import z from "zod";
import { DB } from "../../../../../../db";
import {
	UserAccountSettings,
	UserDataPolicies,
} from "../../../../../utils/shared-models/accountData";

export namespace AdminUsersModel {
	const BaseUser = createSelectSchema(DB.Tables.users);

	export const SafeUser = BaseUser.omit({ password_hash: true });
	export type SafeUser = z.infer<typeof SafeUser>;
}

export namespace AdminUsersModel.GetAll {
	export const Query = z.object({
		role: UserAccountSettings.Role.optional(),
		search: z.string().min(1).max(64).optional(),
		limit: z.coerce.number().int().min(1).max(100).optional(),
		offset: z.coerce.number().int().min(0).optional(),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SafeUser);
	export type Response = z.infer<typeof Response>;
}

export namespace AdminUsersModel.Create {
	const InsertSchema = createInsertSchema(DB.Tables.users, {
		username: UserDataPolicies.Username,
		display_name: z.string().min(1).max(64),
		email: z.email(),
	}).omit({
		id: true,
		password_hash: true,
		created_at: true,
	});

	export const Body = InsertSchema.extend({
		password: z.string().min(8).max(128),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SafeUser;
	export type Response = z.infer<typeof Response>;
}

export namespace AdminUsersModel.Update {
	export const Body = createUpdateSchema(DB.Tables.users)
		.omit({
			id: true,
			password_hash: true,
			created_at: true,
		})
		.partial()
		.refine((data) => Object.values(data).some((value) => value !== undefined), {
			message: "At least one field must be provided",
		});

	export type Body = z.infer<typeof Body>;
}

export namespace AdminUsersModel.UpdatePassword {
	export const Body = z.object({
		password: UserDataPolicies.Password,
	});

	export type Body = z.infer<typeof Body>;
}

export namespace AdminUsersModel.UserId {
	export const Params = z.object({
		userId: z.coerce.number().int().positive(),
	});

	export type Params = z.infer<typeof Params>;
}
