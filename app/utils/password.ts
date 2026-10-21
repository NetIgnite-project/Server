import { z } from "zod";

/**
 * The server's password rule (`UserDataPolicies.Password` in
 * server/lib/api/utils/shared-models/accountData.ts), for forms that check it before submitting.
 */
export const passwordRule = z
	.string("Password is required")
	.min(8, "Must be at least 8 characters")
	.max(50, "Must be at most 50 characters")
	.regex(
		/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/,
		"Needs an upper- and a lower-case letter, a digit and a special character",
	);

export const PASSWORD_HINT =
	"8–50 characters with upper- and lower-case letters, a digit and a special character.";
