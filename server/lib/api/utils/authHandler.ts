import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { AppConstants } from "../../utils/constants";
import { LCrypt } from "../../utils/crypto/lcrypt";
import type { UserAccountSettings } from "./shared-models/accountData";

// Opaque bearer-token auth. Token shape: `<prefix><id>:<base>`
//   prefix — SESSION_TOKEN_PREFIX or API_KEY_PREFIX (carries the kind)
//   id     — 32 random bytes hex; indexes the DB row
//   base   — 32 random bytes hex; stored ONLY as Bun.password.hash(...)
// The full token is handed to the client once at creation; the server re-resolves
// it against the DB on every request (no JWT, no signed claims).

export class AuthUtils {
	static async getUserRole(userID: number, tx: DrizzleDB = DB.instance()) {
		const user = await tx.select().from(DB.Tables.users).where(eq(DB.Tables.users.id, userID)).get();
		if (!user) {
			return null;
		}
		return user.role;
	}

	/** 32 random bytes as a 64-char hex string — used as the token id (DB row key). */
	static createRandomTokenID() {
		return LCrypt.randomBytes(32).toString("hex");
	}

	/** 32 random bytes as a 64-char hex string — the secret half, stored only hashed. */
	static createBaseToken() {
		return LCrypt.randomBytes(32).toString("hex");
	}

	static getFullToken(prefix: AuthHandler.TOKEN_PREFIX, tokenID: string, tokenBase: string) {
		return `${prefix}${tokenID}:${tokenBase}`;
	}

	/** Split a full token into prefix/id/base, or null if the shape is wrong. */
	static getTokenParts(fullToken: string) {
		const parts = fullToken.split(":") as [string, string];
		if (parts.length !== 2) {
			return null;
		}
		if (parts[0].startsWith(SessionHandler.SESSION_TOKEN_PREFIX)) {
			return {
				prefix: SessionHandler.SESSION_TOKEN_PREFIX,
				id: parts[0].substring(SessionHandler.SESSION_TOKEN_PREFIX.length),
				base: parts[1],
			} satisfies AuthHandler.TokenParts;
		} else if (parts[0].startsWith(APIKeyHandler.API_KEY_PREFIX)) {
			return {
				prefix: APIKeyHandler.API_KEY_PREFIX,
				id: parts[0].substring(APIKeyHandler.API_KEY_PREFIX.length),
				base: parts[1],
			} satisfies AuthHandler.TokenParts;
		} else {
			return null;
		}
	}

	static hashTokenBase(tokenBase: string) {
		return Bun.password.hash(tokenBase);
	}

	static verifyHashedTokenBase(tokenBase: string, hashedToken: string) {
		return Bun.password.verify(tokenBase, hashedToken);
	}
}

export class SessionHandler {
	static readonly SESSION_TOKEN_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_sess_`;

	static async createSession(userID: number, tx: DrizzleDB = DB.instance()) {
		const tokenID = AuthUtils.createRandomTokenID();
		const tokenBase = AuthUtils.createBaseToken();

		const fullToken = AuthUtils.getFullToken(this.SESSION_TOKEN_PREFIX, tokenID, tokenBase);

		const result = await tx
			.insert(DB.Tables.sessions)
			.values({
				id: tokenID,
				hashed_token: await AuthUtils.hashTokenBase(tokenBase),
				user_id: userID,
				user_role: (await AuthUtils.getUserRole(userID, tx)) || "user",
				expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).getTime(), // 7 days from now
			})
			.returning()
			.get();

		return {
			token: fullToken,
			user_id: result.user_id,
			user_role: result.user_role,
			created_at: result.created_at,
			expires_at: result.expires_at,
		} satisfies Omit<DB.Models.Session, "id" | "hashed_token"> & { token: string };
	}

	static async getSession(tokenParts: AuthHandler.TokenParts, tx: DrizzleDB = DB.instance()) {
		if (!tokenParts.prefix.startsWith(this.SESSION_TOKEN_PREFIX)) {
			return null;
		}

		const session = await tx
			.select()
			.from(DB.Tables.sessions)
			.where(eq(DB.Tables.sessions.id, tokenParts.id))
			.get();
		if (!session) {
			return null;
		}

		if (!(await AuthUtils.verifyHashedTokenBase(tokenParts.base, session.hashed_token))) {
			return null;
		}

		return session;
	}

	static async isValidSession(session: DB.Models.Session, tx: DrizzleDB = DB.instance()) {
		if (!session) {
			return false;
		}

		if (session.expires_at < Date.now()) {
			// Delete expired session
			await tx.delete(DB.Tables.sessions).where(eq(DB.Tables.sessions.id, session.id));

			return false;
		}

		return true;
	}

	static async inValidateAllSessionsForUser(userID: number, tx: DrizzleDB = DB.instance()) {
		await tx.delete(DB.Tables.sessions).where(eq(DB.Tables.sessions.user_id, userID));
	}

	static async inValidateSession(tokenID: string, tx: DrizzleDB = DB.instance()) {
		await tx.delete(DB.Tables.sessions).where(eq(DB.Tables.sessions.id, tokenID));
	}

	static async changeUserRoleInSessions(
		userID: number,
		newRole: UserAccountSettings.Role,
		tx: DrizzleDB = DB.instance(),
	) {
		await tx
			.update(DB.Tables.sessions)
			.set({
				user_role: newRole,
			})
			.where(eq(DB.Tables.sessions.user_id, userID));
	}
}

export class APIKeyHandler {
	static readonly API_KEY_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_apikey_`;

	static async createApiKey(
		userID: number,
		description: string,
		expiresInDays?: number,
		tx: DrizzleDB = DB.instance(),
	) {
		const expiresAt = expiresInDays
			? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).getTime()
			: null;

		const tokenID = AuthUtils.createRandomTokenID();
		const tokenBase = AuthUtils.createBaseToken();

		const fullToken = AuthUtils.getFullToken(this.API_KEY_PREFIX, tokenID, tokenBase);

		const result = await tx
			.insert(DB.Tables.apiKeys)
			.values({
				id: tokenID,
				hashed_token: await AuthUtils.hashTokenBase(tokenBase),
				user_id: userID,
				user_role: (await AuthUtils.getUserRole(userID, tx)) || "user",
				description: description,
				expires_at: expiresAt,
			})
			.returning()
			.get();

		return {
			token: fullToken,
			user_id: result.user_id,
			user_role: result.user_role,
			created_at: result.created_at,
			expires_at: result.expires_at,
			description: result.description,
		} satisfies Omit<DB.Models.ApiKey, "id" | "hashed_token"> & { token: string };
	}

	static async getApiKey(tokenParts: AuthHandler.TokenParts, tx: DrizzleDB = DB.instance()) {
		if (!tokenParts.prefix.startsWith(this.API_KEY_PREFIX)) {
			return null;
		}

		const key = await tx
			.select()
			.from(DB.Tables.apiKeys)
			.where(eq(DB.Tables.apiKeys.id, tokenParts.id))
			.get();

		if (!key) {
			return null;
		}

		if (!(await AuthUtils.verifyHashedTokenBase(tokenParts.base, key.hashed_token))) {
			return null;
		}

		return key;
	}

	static async isValidApiKey(key: Omit<DB.Models.ApiKey, "id">, tx: DrizzleDB = DB.instance()) {
		if (!key) {
			return false;
		}

		if (key.expires_at && key.expires_at < Date.now()) {
			return false;
		}

		return true;
	}

	static async deleteAllApiKeysForUser(userID: number, tx: DrizzleDB = DB.instance()) {
		await tx.delete(DB.Tables.apiKeys).where(eq(DB.Tables.apiKeys.user_id, userID));
	}

	static async deleteApiKey(apiKeyID: string, tx: DrizzleDB = DB.instance()) {
		await tx.delete(DB.Tables.apiKeys).where(eq(DB.Tables.apiKeys.id, apiKeyID));
	}

	static async changeUserRoleInApiKeys(
		userID: number,
		newRole: UserAccountSettings.Role,
		tx: DrizzleDB = DB.instance(),
	) {
		await tx
			.update(DB.Tables.apiKeys)
			.set({
				user_role: newRole,
			})
			.where(eq(DB.Tables.apiKeys.user_id, userID));
	}
}

export class AuthHandler {
	static getTokenType(token: string) {
		if (token.startsWith(SessionHandler.SESSION_TOKEN_PREFIX)) {
			return "session";
		} else if (token.startsWith(APIKeyHandler.API_KEY_PREFIX)) {
			return "apiKey";
		} else {
			return "unknown";
		}
	}

	/** Resolve a bearer token into a session or apiKey auth context, or null. */
	static async getAuthContext(
		fullToken: string,
		tx: DrizzleDB = DB.instance(),
	): Promise<AuthHandler.AuthenticatedAuthContext | null> {
		const tokenParts = AuthUtils.getTokenParts(fullToken);
		if (!tokenParts) {
			return null;
		}

		switch (this.getTokenType(fullToken)) {
			case "session": {
				const session = await SessionHandler.getSession(tokenParts, tx);
				if (!session) {
					return null;
				}
				return {
					type: "session" as const,
					...session,
				};
			}
			case "apiKey": {
				const apiKey = await APIKeyHandler.getApiKey(tokenParts, tx);
				if (!apiKey) {
					return null;
				}
				return {
					type: "apiKey" as const,
					...apiKey,
				};
			}
			default:
				return null;
		}
	}

	static async isValidAuthContext(
		authContext: AuthHandler.AuthContext,
		tx: DrizzleDB = DB.instance(),
	): Promise<boolean> {
		switch (authContext.type) {
			case "session":
				return await SessionHandler.isValidSession(authContext, tx);
			case "apiKey":
				return await APIKeyHandler.isValidApiKey(authContext, tx);
			default:
				return false;
		}
	}

	static async invalidateAuthContext(
		authContext: AuthHandler.AuthContext,
		tx: DrizzleDB = DB.instance(),
	): Promise<void> {
		switch (authContext.type) {
			case "session":
				await SessionHandler.inValidateSession(authContext.id, tx);
				break;
			case "apiKey":
				await APIKeyHandler.deleteApiKey(authContext.id, tx);
				break;
		}
	}

	static async invalidateAllAuthContextsForUser(
		userID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<void> {
		return await Promise.all([
			SessionHandler.inValidateAllSessionsForUser(userID, tx),
			APIKeyHandler.deleteAllApiKeysForUser(userID, tx),
		]).then(() => {
			return;
		});
	}

	static async changeUserRoleInAuthContexts(
		userID: number,
		newRole: UserAccountSettings.Role,
		tx: DrizzleDB = DB.instance(),
	): Promise<void> {
		return await Promise.all([
			SessionHandler.changeUserRoleInSessions(userID, newRole, tx),
			APIKeyHandler.changeUserRoleInApiKeys(userID, newRole, tx),
		]).then(() => {
			return;
		});
	}
}

export namespace AuthHandler {
	export type TOKEN_PREFIX =
		| typeof SessionHandler.SESSION_TOKEN_PREFIX
		| typeof APIKeyHandler.API_KEY_PREFIX;

	export type AuthenticatedAuthContext = SessionAuthContext | ApiKeyAuthContext;
	export type AuthContext = AuthenticatedAuthContext | UnauthenticatedAuthContext;

	export interface SessionAuthContext extends DB.Models.Session {
		readonly type: "session";
	}

	export interface ApiKeyAuthContext extends DB.Models.ApiKey {
		readonly type: "apiKey";
	}

	export interface UnauthenticatedAuthContext {
		readonly type: "unauthenticated";
	}

	export interface TokenParts {
		readonly prefix: TOKEN_PREFIX;
		readonly id: string;
		readonly base: string;
	}
}

export namespace AuthHandler.AuthContext {
	export function get(c: Context): AuthHandler.AuthContext {
		// @ts-ignore
		const authContext = c.get("authContext") as AuthHandler.AuthContext | undefined;
		if (!authContext) {
			throw new Error("Auth context not set in context");
		}
		return authContext;
	}

	export function getAsSession(c: Context): AuthHandler.SessionAuthContext {
		return AuthHandler.AuthContext.get(c) as AuthHandler.SessionAuthContext;
	}

	export function getAsApiKey(c: Context): AuthHandler.ApiKeyAuthContext {
		return AuthHandler.AuthContext.get(c) as AuthHandler.ApiKeyAuthContext;
	}

	export function set(c: Context, authContext: AuthHandler.AuthContext) {
		return c.set("authContext", authContext);
	}
}
