import z from "zod";
import { UserDataPolicies } from "../../../../../utils/shared-models/accountData";

export namespace ResetPasswordModel.RequestReset {
	export const Body = z.object({
		email: z.email(),
	});
	export type Body = z.infer<typeof Body>;
}

export namespace ResetPasswordModel.Reset {
	export const Body = z.object({
		reset_token: z.string().min(1),
		new_password: UserDataPolicies.Password,
	});

	export type Body = z.infer<typeof Body>;
}
