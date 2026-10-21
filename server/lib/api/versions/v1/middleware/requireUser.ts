import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { APIResponse } from "../../../utils/api-res";
import { AuthHandler } from "../../../utils/authHandler";

/**
 * Rejects unauthenticated requests. Unlike the account routes, resource routes (agents, devices)
 * accept sessions **and** API keys, so scripts can wake devices.
 */
export const requireUser = createMiddleware(async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);
	if (authContext.type === "unauthenticated") {
		return APIResponse.unauthorized(c, "Authentication required");
	}
	await next();
});

/** The authenticated user's id. Only call behind {@link requireUser}. */
export function getUserID(c: Context) {
	const authContext = AuthHandler.AuthContext.get(c);
	if (authContext.type === "unauthenticated") {
		throw new Error("getUserID() called on an unauthenticated request");
	}
	return authContext.user_id;
}
