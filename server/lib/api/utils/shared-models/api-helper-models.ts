import { z } from "zod";

export namespace ApiHelperModels.ListAll {
	export const Query = z.object({
		limit: z.coerce.number().int().positive().min(1).max(100).default(10),
		offset: z.coerce.number().int().min(0).default(0),
		order: z.enum(["newest", "oldest"]).default("newest"),
	});

	export type Query = z.infer<typeof Query>;

	export const QueryWithSearch = Query.extend({
		searchString: z.string().min(3).optional(),
	});

	export type QueryWithSearch = z.infer<typeof QueryWithSearch>;
}
