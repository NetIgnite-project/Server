import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { type CapturedEmail, EmailService } from "../server/lib/api/utils/email";
import { hashResetToken } from "../server/lib/api/versions/v1/routes/auth/reset-password";
import { DB } from "../server/lib/db";
import { AppConstants } from "../server/lib/utils/constants";
import { makeAPIRequest } from "./helpers/api";
import { createMemoryTransport } from "./helpers/memory-transport";
import type { SeededSession, SeededUser } from "./helpers/seed";
import { seedSession, seedUser } from "./helpers/seed";

/** Emails captured by the in-memory transport, isolated to this file. */
const capturedEmails: CapturedEmail[] = [];

describe("EmailService", () => {
	beforeAll(() => {
		// Inject the memory transport so we can assert on sent emails
		EmailService.init(createMemoryTransport(capturedEmails));
	});

	afterAll(() => {
		// Restore to unconfigured so other test files are unaffected
		EmailService.reset();
	});

	test("isEnabled() returns true when memory transport is injected", () => {
		expect(EmailService.isEnabled()).toBe(true);
	});

	test("starts with no captured emails", () => {
		expect(capturedEmails).toHaveLength(0);
	});
});

describe("Password reset email integration", () => {
	let resetUser: SeededUser;
	let resetSession: SeededSession;

	beforeAll(async () => {
		// Ensure the memory transport is active for this describe block too.
		// Re-init is idempotent as long as we pass the same output array.
		EmailService.init(createMemoryTransport(capturedEmails));

		resetUser = await seedUser("user");
		resetSession = await seedSession(resetUser.id);
		capturedEmails.length = 0;
	});

	afterAll(() => {
		EmailService.reset();
	});

	test("POST /auth/reset-password/request sends email for existing user", async () => {
		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: resetUser.email },
			},
			200,
		);

		expect(capturedEmails).toHaveLength(1);
		expect(capturedEmails[0]!.to).toBe(resetUser.email);
		expect(capturedEmails[0]!.subject).toBe(`${AppConstants.APP_NAME} — Password Reset Request`);
	});

	test("Email contains a valid reset link with token", async () => {
		// Use a fresh user to avoid rate-limiting from the previous test
		const freshUser = await seedUser("user");
		capturedEmails.length = 0;

		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: freshUser.email },
			},
			200,
		);

		expect(capturedEmails).toHaveLength(1);

		const html = capturedEmails[0]!.html;
		// Extract the reset URL from the HTML
		const urlMatch = html.match(/href="([^"]*reset-password\?token=[^"]+)"/);
		expect(urlMatch).not.toBeNull();

		const resetUrl = urlMatch![1]!;
		const urlObj = new URL(resetUrl);
		const token = urlObj.searchParams.get("token");
		expect(token).not.toBeNull();
		expect(token!.length).toBeGreaterThan(0);

		// Verify the token is stored in DB (HMAC'd)
		const hashed = hashResetToken(token!);
		const dbToken = DB.instance()
			.select()
			.from(DB.Tables.passwordResets)
			.where(eq(DB.Tables.passwordResets.token, hashed))
			.get();
		expect(dbToken).not.toBeNull();
	});

	test("POST /auth/reset-password/request does NOT send email for unknown user", async () => {
		capturedEmails.length = 0;

		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: `nope-${randomUUID()}@example.com` },
			},
			200,
		);

		expect(capturedEmails).toHaveLength(0);
	});

	test("Rate limit prevents duplicate emails within the window", async () => {
		const rateLimitUser = await seedUser("user");
		capturedEmails.length = 0;

		// First request — should send email
		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: rateLimitUser.email },
			},
			200,
		);

		expect(capturedEmails).toHaveLength(1);

		// Second request for same email — rate limited, no email
		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: rateLimitUser.email },
			},
			200,
		);

		expect(capturedEmails).toHaveLength(1);
	});

	test("Authenticated users cannot request reset and no email is sent", async () => {
		capturedEmails.length = 0;

		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				authToken: resetSession.token,
				body: { email: resetUser.email },
			},
			401,
		);

		expect(capturedEmails).toHaveLength(0);
	});

	test("Full reset flow: request → extract token from email → consume token → password changed", async () => {
		const flowUser = await seedUser("user");
		capturedEmails.length = 0;

		const newPassword = "N3wP@ssw0rd!";

		// 1. Request reset
		await makeAPIRequest(
			"/v1/auth/reset-password/request",
			{
				method: "POST",
				body: { email: flowUser.email },
			},
			200,
		);

		// 2. Extract token from captured email
		expect(capturedEmails).toHaveLength(1);
		const urlMatch = capturedEmails[0]!.html.match(/href="([^"]*reset-password\?token=[^"]+)"/);
		expect(urlMatch).not.toBeNull();
		const token = new URL(urlMatch![1]!).searchParams.get("token")!;

		// 3. Create a session before consuming the token — it should be invalidated
		const oldSession = await seedSession(flowUser.id);

		// 4. Consume the token (this invalidates all sessions for the user)
		await makeAPIRequest(
			"/v1/auth/reset-password",
			{
				method: "POST",
				body: {
					reset_token: token,
					new_password: newPassword,
				},
			},
			200,
		);

		// 5. Verify old session is invalidated
		await makeAPIRequest("/v1/auth/session", { authToken: oldSession.token }, 401);

		// 6. Verify new password works
		const login = await makeAPIRequest(
			"/v1/auth/login",
			{
				method: "POST",
				body: {
					username: flowUser.username,
					password: newPassword,
				},
			},
			200,
		);

		expect(login.token).toStartWith(`${AppConstants.APP_KEYS_PREFIX}_sess_`);
	});

	test("Expired reset token is rejected", async () => {
		const expiredUser = await seedUser("user");
		capturedEmails.length = 0;

		const expiredToken = `expired_${randomUUID().replace(/-/g, "")}`;
		await DB.instance()
			.insert(DB.Tables.passwordResets)
			.values({
				token: hashResetToken(expiredToken),
				user_id: expiredUser.id,
				expires_at: Date.now() - 1000, // 1 second in the past
			})
			.run();

		await makeAPIRequest(
			"/v1/auth/reset-password",
			{
				method: "POST",
				body: {
					reset_token: expiredToken,
					new_password: "N3wP@ssw0rd!",
				},
			},
			400,
		);
	});

	test("Consuming a reset token deletes all tokens for that user", async () => {
		const multiTokenUser = await seedUser("user");
		capturedEmails.length = 0;

		const token1 = `multi_${randomUUID().replace(/-/g, "")}`;
		const token2 = `multi_${randomUUID().replace(/-/g, "")}`;

		await DB.instance()
			.insert(DB.Tables.passwordResets)
			.values([
				{ token: hashResetToken(token1), user_id: multiTokenUser.id, expires_at: Date.now() + 600_000 },
				{ token: hashResetToken(token2), user_id: multiTokenUser.id, expires_at: Date.now() + 600_000 },
			])
			.run();

		// Consume token1
		await makeAPIRequest(
			"/v1/auth/reset-password",
			{
				method: "POST",
				body: {
					reset_token: token1,
					new_password: "An0therP@ss!",
				},
			},
			200,
		);

		// Both tokens should be gone
		const remaining = DB.instance()
			.select()
			.from(DB.Tables.passwordResets)
			.where(eq(DB.Tables.passwordResets.user_id, multiTokenUser.id))
			.all();
		expect(remaining).toHaveLength(0);
	});
});
