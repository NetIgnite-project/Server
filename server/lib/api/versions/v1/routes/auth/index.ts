import { eq, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler, SessionHandler } from "../../../../utils/authHandler";
import { RuntimeMetadata } from "../../../../utils/metadata";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { AuthModel } from "./model";

// Dummy bcrypt hash for timing-normalized login failures — prevents username enumeration
// Generated once at module load so it's a valid, cost-equivalent hash
const DUMMY_PASSWORD_HASH = await Bun.password.hash("dummy-timing-constant");

// Simple in-memory rate limiter for login to reduce brute-force risk
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_MAX_GLOBAL_ATTEMPTS = 15; // Per-username limit across all IPs
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const globalLoginAttempts = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent unbounded memory growth — runs every 5 minutes
const LOGIN_CLEANUP_INTERVAL = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of loginAttempts) {
		if (entry.resetAt <= now) loginAttempts.delete(key);
	}
	for (const [key, entry] of globalLoginAttempts) {
		if (entry.resetAt <= now) globalLoginAttempts.delete(key);
	}
}, LOGIN_WINDOW_MS);
// Allow the process to exit without waiting for this interval
LOGIN_CLEANUP_INTERVAL.unref();

function getClientId(c: Context) {
	// @ts-ignore bun/hono provides a native request with connection info
	const remote = (c.req.raw as any)?.remoteAddr?.hostname;
	return remote || "unknown";
}

function getLoginAttemptKey(clientId: string, username: string) {
	return `${clientId}:${username.toLowerCase()}`;
}

function getGlobalLoginAttemptKey(username: string) {
	return username.toLowerCase();
}

/**
 * Register a failed attempt, incrementing the counter atomically.
 * Returns the new count after increment — no await between read and write.
 */
function registerFailedLoginAttempt(
	loginAttemptKey: string,
	globalKey: string,
): { perIpCount: number; globalCount: number } {
	const now = Date.now();

	// Per-IP-per-username counter
	let entry = loginAttempts.get(loginAttemptKey);
	if (!entry || entry.resetAt <= now) {
		entry = { count: 1, resetAt: now + LOGIN_WINDOW_MS };
		loginAttempts.set(loginAttemptKey, entry);
	} else {
		entry.count += 1;
	}

	// Global per-username counter
	let globalEntry = globalLoginAttempts.get(globalKey);
	if (!globalEntry || globalEntry.resetAt <= now) {
		globalEntry = { count: 1, resetAt: now + LOGIN_WINDOW_MS };
		globalLoginAttempts.set(globalKey, globalEntry);
	} else {
		globalEntry.count += 1;
	}

	return { perIpCount: entry.count, globalCount: globalEntry.count };
}

function clearFailedLoginAttempts(loginAttemptKey: string, globalKey: string) {
	loginAttempts.delete(loginAttemptKey);
	globalLoginAttempts.delete(globalKey);
}

export const router = new Hono().basePath("/auth");

router.post(
	"/login",

	APIRouteSpec.unauthenticated({
		summary: "User Login",
		description: "Authenticate a user with their username and password",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Login successful", AuthModel.Login.Response),
			APIResponseSpec.unauthorized("Unauthorized: Invalid username or password"),
			APIResponseSpec.tooManyRequests("Too many login attempts. Try again later."),
		),
	}),

	zValidator("json", AuthModel.Login.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c) as AuthHandler.UnauthenticatedAuthContext;
		if (authContext.type !== "unauthenticated") {
			return APIResponse.forbidden(c, "You are already authenticated");
		}

		const { username, password } = c.req.valid("json");

		try {
			const clientId = getClientId(c);
			const loginAttemptKey = getLoginAttemptKey(clientId, username);
			const globalKey = getGlobalLoginAttemptKey(username);

			// Increment counters FIRST, then check limits — eliminates TOCTOU race
			const { perIpCount, globalCount } = registerFailedLoginAttempt(loginAttemptKey, globalKey);

			if (perIpCount > LOGIN_MAX_ATTEMPTS || globalCount > LOGIN_MAX_GLOBAL_ATTEMPTS) {
				const retrySeconds = Math.max(1, Math.ceil(LOGIN_WINDOW_MS / 1000));
				c.header("Retry-After", retrySeconds.toString());
				return APIResponse.tooManyRequests(c, `Too many login attempts. Try again in ${retrySeconds}s`);
			}

			const user = DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.username, username))
				.get();
			if (!user) {
				// Timing-normalized: always run a bcrypt call to prevent username enumeration
				await Bun.password.verify("dummy-timing-constant", DUMMY_PASSWORD_HASH);
				return APIResponse.unauthorized(c, "Invalid username or password");
			}

			const passwordMatch = await Bun.password.verify(password, user.password_hash);
			if (!passwordMatch) {
				return APIResponse.unauthorized(c, "Invalid username or password");
			}

			// Successful login — clear all counters for this user
			clearFailedLoginAttempts(loginAttemptKey, globalKey);

			// Users imported from NetIgnite v1 still have bcrypt hashes; upgrade them to argon2id.
			if (user.password_hash.startsWith("$2")) {
				await DB.instance()
					.update(DB.Tables.users)
					.set({ password_hash: await Bun.password.hash(password) })
					.where(eq(DB.Tables.users.id, user.id));
			}

			const session = await DB.instance().transaction(async (tx: DrizzleDB) => {
				return await SessionHandler.createSession(user.id, tx);
			});

			return APIResponse.success(c, "Login successful", session satisfies AuthModel.Login.Response);
		} catch (error: any) {
			Logger.error("Failed to create session", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to create session");
		}
	},
);

router.get(
	"/session",

	APIRouteSpec.authenticated({
		summary: "Get Current Session",
		description: "Retrieve the current user's session information",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Session info retrieved successfully", AuthModel.Session.Response),
			APIResponseSpec.unauthorized(
				"Unauthorized: Invalid or missing session token / Your Auth Context is not a session",
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);
		if (authContext.type !== "session") {
			return APIResponse.unauthorized(c, "Your Auth Context is not a session");
		}

		return APIResponse.success(c, "Session info retrieved successfully", {
			user_id: authContext.user_id,
			user_role: authContext.user_role,
			created_at: authContext.created_at,
			expires_at: authContext.expires_at,
		} satisfies AuthModel.Session.Response);
	},
);

router.post(
	"/logout",

	APIRouteSpec.authenticated({
		summary: "User Logout",
		description: "Invalidate the current user's session",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Logout successful"),
			APIResponseSpec.unauthorized(
				"Unauthorized: Invalid or missing session token / Your Auth Context is not a session",
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);

		if (authContext.type !== "session") {
			return APIResponse.unauthorized(c, "Your Auth Context is not a session");
		}

		await SessionHandler.inValidateSession(authContext.id);

		return APIResponse.successNoData(c, "Logout successful");
	},
);

// Signup is allowed only while an admin has enabled public registration.
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_CLIENT = 5;
const signupAttempts = new Map<string, { count: number; resetAt: number }>();

router.get(
	"/registration",

	APIRouteSpec.unauthenticated({
		summary: "Registration status",
		description: "Whether public sign-up is enabled on this server.",
		tags: [DOCS_TAGS.AUTHENTICATION],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Registration status", AuthModel.Registration.Response),
		),
	}),

	async (c) => {
		const { registration_enabled } = await RuntimeMetadata.getSettings();
		return APIResponse.success(c, "Registration status", { enabled: registration_enabled });
	},
);

router.post(
	"/signup",

	APIRouteSpec.unauthenticated({
		summary: "Sign up",
		description:
			"Creates a user account and logs it in. Only available while public registration is enabled.",
		tags: [DOCS_TAGS.AUTHENTICATION],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.created("Account created", AuthModel.Signup.Response),
			APIResponseSpec.forbidden("Public registration is disabled"),
			APIResponseSpec.conflict("Username or email address already in use"),
			APIResponseSpec.tooManyRequests("Too many sign-ups from this client"),
		),
	}),

	zValidator("json", AuthModel.Signup.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);
		if (authContext.type !== "unauthenticated") {
			return APIResponse.forbidden(c, "You are already authenticated");
		}

		if (!(await RuntimeMetadata.getSettings()).registration_enabled) {
			return APIResponse.forbidden(c, "Public registration is disabled on this server");
		}

		const clientId = getClientId(c);
		const now = Date.now();
		let attempts = signupAttempts.get(clientId);
		if (!attempts || attempts.resetAt <= now) {
			attempts = { count: 0, resetAt: now + SIGNUP_WINDOW_MS };
			signupAttempts.set(clientId, attempts);
		}
		attempts.count += 1;
		if (attempts.count > SIGNUP_MAX_PER_CLIENT) {
			return APIResponse.tooManyRequests(c, "Too many sign-ups, try again later");
		}

		const { username, email, password, display_name } = c.req.valid("json");

		const duplicate = DB.instance()
			.select({ id: DB.Tables.users.id })
			.from(DB.Tables.users)
			.where(or(eq(DB.Tables.users.username, username), eq(DB.Tables.users.email, email)))
			.get();
		if (duplicate) {
			return APIResponse.conflict(c, "Username or email address already in use");
		}

		try {
			const user = DB.instance()
				.insert(DB.Tables.users)
				.values({
					username,
					email,
					display_name: display_name ?? username,
					password_hash: await Bun.password.hash(password),
					role: "user",
				})
				.returning()
				.get();
			const session = await SessionHandler.createSession(user.id);

			return APIResponse.created(c, "Account created", session satisfies AuthModel.Signup.Response);
		} catch (error: any) {
			Logger.error("Failed to create account", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to create account");
		}
	},
);

router.route("/", (await import("./reset-password")).router);
