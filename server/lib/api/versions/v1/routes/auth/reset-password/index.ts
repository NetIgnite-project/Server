import { randomBytes as crypto_randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { LCrypt } from "../../../../../../utils/crypto/lcrypt";
import { Logger } from "../../../../../../utils/logger";
import { APIResponse } from "../../../../../utils/api-res";
import { AuthHandler, SessionHandler } from "../../../../../utils/authHandler";
import { EmailService } from "../../../../../utils/email";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { ResetPasswordModel } from "./model";

// In-memory rate limiter for password reset requests
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RESET_REQUEST_MAX_PER_EMAIL = 1;
const RESET_CONSUME_MAX_PER_TOKEN = 3;
const resetRequestAttempts = new Map<string, { count: number; resetAt: number }>();
const resetConsumeAttempts = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent memory leaks
const RESET_CLEANUP_INTERVAL = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of resetRequestAttempts) {
		if (entry.resetAt <= now) resetRequestAttempts.delete(key);
	}
	for (const [key, entry] of resetConsumeAttempts) {
		if (entry.resetAt <= now) resetConsumeAttempts.delete(key);
	}
}, RESET_REQUEST_WINDOW_MS);
RESET_CLEANUP_INTERVAL.unref();

// Tokens are stored hashed, never in plaintext. Uses LCrypt.sha256 (sha3-256)
// so init-time tokens (db/index) and endpoint tokens share one algorithm.
export function hashResetToken(resetToken: string) {
	return LCrypt.sha256(resetToken).toHex();
}

function checkRateLimit(
	map: Map<string, { count: number; resetAt: number }>,
	key: string,
	maxAttempts: number,
	windowMs: number,
): boolean {
	const now = Date.now();
	let entry = map.get(key);
	if (!entry || entry.resetAt <= now) {
		entry = { count: 1, resetAt: now + windowMs };
		map.set(key, entry);
		return true; // allowed
	}
	entry.count += 1;
	if (entry.count > maxAttempts) {
		return false; // blocked
	}
	return true;
}

export const router = new Hono().basePath("/reset-password");

router.post(
	"/",

	APIRouteSpec.unauthenticated({
		summary: "Reset your password using a reset token",
		description: "Reset your password using a valid reset token",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.badRequest("Invalid reset token"),
			APIResponseSpec.unauthorized("You are already authenticated"),
			APIResponseSpec.successNoData("Password has been reset successfully"),
		),
	}),

	zValidator("json", ResetPasswordModel.Reset.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c) as AuthHandler.UnauthenticatedAuthContext;
		if (authContext.type !== "unauthenticated") {
			return APIResponse.unauthorized(c, "You are already authenticated");
		}

		const resetData = c.req.valid("json");

		try {
			const hashedResetToken = hashResetToken(resetData.reset_token);

			// Rate limit: max 3 attempts per token
			if (
				!checkRateLimit(
					resetConsumeAttempts,
					hashedResetToken,
					RESET_CONSUME_MAX_PER_TOKEN,
					RESET_REQUEST_WINDOW_MS,
				)
			) {
				return APIResponse.badRequest(c, "Invalid reset token");
			}

			let checkToken = DB.instance()
				.select()
				.from(DB.Tables.passwordResets)
				.where(eq(DB.Tables.passwordResets.token, hashedResetToken))
				.get();

			if (!checkToken) {
				return APIResponse.badRequest(c, "Invalid reset token");
			}

			if (checkToken.expires_at < Date.now()) {
				return APIResponse.badRequest(c, "Invalid reset token");
			}

			const user = DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.id, checkToken.user_id))
				.get();

			if (!user) {
				throw new Error("User for reset token not found");
			}

			const newPasswordHash = await Bun.password.hash(resetData.new_password);

			await DB.instance().transaction(async (tx: DrizzleDB) => {
				await tx
					.update(DB.Tables.users)
					.set({
						password_hash: newPasswordHash,
					})
					.where(eq(DB.Tables.users.id, user.id))
					.run();

				await AuthHandler.invalidateAllAuthContextsForUser(user.id, tx);

				await tx
					.delete(DB.Tables.passwordResets)
					.where(eq(DB.Tables.passwordResets.user_id, user.id))
					.run();
			});

			return APIResponse.successNoData(c, "Password has been reset successfully");
		} catch (error: any) {
			Logger.error("Failed to reset password", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to reset password");
		}
	},
);

router.post(
	"/request",

	APIRouteSpec.unauthenticated({
		summary: "Request Password Reset",
		description: "Request a password reset for a user using their username",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("If the username exists, a password reset has been requested"),
		),
	}),

	zValidator("json", ResetPasswordModel.RequestReset.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c) as AuthHandler.UnauthenticatedAuthContext;
		if (authContext.type !== "unauthenticated") {
			return APIResponse.unauthorized(c, "You are already authenticated");
		}

		const requestData = c.req.valid("json");

		// Rate limit: max 1 reset request per email per 15 minutes
		if (
			!checkRateLimit(
				resetRequestAttempts,
				requestData.email.toLowerCase(),
				RESET_REQUEST_MAX_PER_EMAIL,
				RESET_REQUEST_WINDOW_MS,
			)
		) {
			return APIResponse.successNoData(
				c,
				"If the username exists, a password reset has been requested",
			);
		}

		const user = DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.email, requestData.email))
			.get();

		if (user) {
			const resetToken = crypto_randomBytes(64).toString("hex");

			try {
				await DB.instance().transaction(async (tx: DrizzleDB) => {
					// Delete any existing reset tokens for this user
					await tx
						.delete(DB.Tables.passwordResets)
						.where(eq(DB.Tables.passwordResets.user_id, user.id))
						.run();

					// Create new reset token — 1 hour expiry (OWASP recommendation: 15-60 min)
					await tx
						.insert(DB.Tables.passwordResets)
						.values({
							user_id: user.id,
							token: hashResetToken(resetToken),
							expires_at: Date.now() + 60 * 60 * 1000, // 1 hour
						})
						.run();
				});
			} catch (error: any) {
				Logger.error("Failed to request password reset", error.stack || error.message || error);
				return APIResponse.serverError(c, "Failed to request password reset");
			}

			// send email with reset token (fire-and-forget — errors are logged server-side)
			if (EmailService.isEnabled()) {
				EmailService.sendPasswordResetEmail(user.email, resetToken);
			}
		}

		return APIResponse.successNoData(
			c,
			"If the username exists, a password reset has been requested",
		);
	},
);
