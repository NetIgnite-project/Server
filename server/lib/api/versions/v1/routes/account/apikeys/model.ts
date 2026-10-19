import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import z from "zod";
import { DB } from "../../../../../../db";

export namespace AccountAPIKeysModel.GetById {
	export const Response = createSelectSchema(DB.Tables.apiKeys).omit({
		user_id: true,
		user_role: true,
		hashed_token: true,
	});

	export type Response = z.infer<typeof Response>;
}

export namespace AccountAPIKeysModel.GetAll {
	export const Response = z.array(AccountAPIKeysModel.GetById.Response);
	export type Response = z.infer<typeof Response>;
}

export namespace AccountAPIKeysModel.Create {
	export const Body = createInsertSchema(DB.Tables.apiKeys, {
		expires_at: z.union([
			z.literal("7d").meta({ title: "7 days" }),
			z.literal("30d").meta({ title: "30 days" }),
			z.literal("90d").meta({ title: "90 days" }),
			z.literal("180d").meta({ title: "180 days" }),
			z.literal("365d").meta({ title: "365 days" }),
			z.literal(null).meta({ title: "No expiration" }),
		]),
		description: z
			.string()
			.min(1, "Description cannot be empty")
			.max(255, "Description cannot exceed 255 characters"),
	}).omit({
		id: true,
		user_id: true,
		user_role: true,
		hashed_token: true,
		created_at: true,
	});

	export type Body = z.infer<typeof Body>;

	export const Response = z.object({
		id: z.string(),
		token: z.string(),
	});

	export type Response = z.infer<typeof Response>;
}
