import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler, SessionHandler } from "../../../../utils/authHandler";
import { UserPreferencesHandler } from "../../../../utils/preferences";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { AccountModel } from "./model";

export const router = new Hono().basePath("/account");

// all routes below require authentication via session
router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (authContext.type !== "session") {
		return APIResponse.unauthorized(c, "Your Auth Context is not a session");
	}

	await next();
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get account information",
		description: "Retrieve information about the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Account information retrieved successfully",
				AccountModel.GetInfo.Response,
			),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const user = DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.id, authContext.user_id))
			.get();

		if (!user) {
			throw new Error("User not found but session exists");
		}

		const userWithoutSensitive = AccountModel.GetInfo.Response.parse(user);

		return APIResponse.success(c, "Account information retrieved successfully", userWithoutSensitive);
	},
);

router.put(
	"/",

	APIRouteSpec.authenticated({
		summary: "Update account information",
		description: "Update information about the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Account information updated successfully"),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
			APIResponseSpec.conflict("Username or email already in use"),
		),
	}),

	validator("json", AccountModel.UpdateInfo.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const body = c.req.valid("json") as AccountModel.UpdateInfo.Body;
		const { current_password, ...updates } = body;

		// Verify current password before allowing changes
		const user = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.id, authContext.user_id))
			.get();

		if (!user) {
			throw new Error("User not found but session exists");
		}

		if (!(await Bun.password.verify(current_password, user.password_hash))) {
			return APIResponse.unauthorized(c, "Current password is incorrect");
		}

		// Check for conflicts if changing username or email
		if (updates.username && updates.username !== user.username) {
			const usernameConflict = await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.username, updates.username))
				.get();
			if (usernameConflict) {
				return APIResponse.conflict(c, "Username already in use");
			}
		}

		if (updates.email && updates.email !== user.email) {
			const emailConflict = await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.email, updates.email))
				.get();
			if (emailConflict) {
				return APIResponse.conflict(c, "Email already in use");
			}
		}

		await DB.instance()
			.update(DB.Tables.users)
			.set(updates)
			.where(eq(DB.Tables.users.id, authContext.user_id))
			.run();

		return APIResponse.successNoData(c, "Account information updated successfully");
	},
);

router.put(
	"/password",

	APIRouteSpec.authenticated({
		summary: "Change account password",
		description: "Change the password of the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Password changed successfully"),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
			APIResponseSpec.badRequest(
				"Current password is incorrect / Syntax or validation error in request",
			),
		),
	}),

	validator("json", AccountModel.UpdatePassword.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const body = c.req.valid("json");

		try {
			const user = DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.id, authContext.user_id))
				.get();

			if (!user) {
				throw new Error("User not found but session exists");
			}

			if ((await Bun.password.verify(body.current_password, user.password_hash)) === false) {
				return APIResponse.unauthorized(c, "Current password is incorrect");
			}

			const newPasswordHash = await Bun.password.hash(body.new_password);

			await DB.instance().transaction(async (tx: DrizzleDB) => {
				await tx
					.update(DB.Tables.users)
					.set({
						password_hash: newPasswordHash,
					})
					.where(eq(DB.Tables.users.id, authContext.user_id))
					.run();

				await SessionHandler.inValidateAllSessionsForUser(authContext.user_id, tx);
			});

			return APIResponse.successNoData(c, "Password changed successfully");
		} catch (error: any) {
			Logger.error("change password transaction failed:", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to change password");
		}
	},
);

router.delete(
	"/",

	APIRouteSpec.authenticated({
		summary: "Delete account",
		description: "Permanently delete the authenticated user's account.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Account deleted successfully"),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		try {
			await DB.instance().transaction(async (tx: DrizzleDB) => {
				// invalidate all sessions for the user
				await AuthHandler.invalidateAllAuthContextsForUser(authContext.user_id, tx);

				// delete password resets
				await tx
					.delete(DB.Tables.passwordResets)
					.where(eq(DB.Tables.passwordResets.user_id, authContext.user_id))
					.run();

				// delete stored preferences
				await UserPreferencesHandler.deleteAllForUser(authContext.user_id, tx);

				// finally, delete the user account
				await tx.delete(DB.Tables.users).where(eq(DB.Tables.users.id, authContext.user_id)).run();
			});

			return APIResponse.successNoData(c, "Account deleted successfully");
		} catch (error: any) {
			Logger.error("Failed to delete account", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to delete account");
		}
	},
);

router.route("/", (await import("./apikeys")).router);
router.route("/", (await import("./preferences")).router);
