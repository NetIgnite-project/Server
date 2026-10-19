import { createMiddleware } from "hono/factory";
import { APIResponse } from "../../../utils/api-res";
import { AuthHandler } from "../../../utils/authHandler";

// Endpoints that stay reachable with a malformed, invalid or expired token (login, signup,
// password reset), so a stale session cookie can never lock a user out of signing in again.
const PUBLIC_AUTH_PATHS = [
	"/v1/auth/login",
	"/v1/auth/signup",
	"/v1/auth/registration",
	"/v1/auth/reset-password",
	"/v1/agents/enroll",
];

// `c.req.path` is the full request path. Compare from `/v1/` on, so this also works when the
// API is mounted under a prefix (the full-stack template serves it at `/api/v1/...`).
function isPublicAuthPath(fullPath: string) {
	const path = fullPath.slice(Math.max(fullPath.indexOf("/v1/"), 0));
	return PUBLIC_AUTH_PATHS.some((publicPath) => path.startsWith(publicPath));
}

export const authMiddlewareV1 = createMiddleware(async (c, next) => {
	const authHeader = c.req.header("Authorization");

	if (!authHeader) {
		AuthHandler.AuthContext.set(c, {
			type: "unauthenticated",
		} satisfies AuthHandler.UnauthenticatedAuthContext);

		return await next();
	}

	if (!authHeader.startsWith("Bearer ")) {
		if (isPublicAuthPath(c.req.path)) {
			AuthHandler.AuthContext.set(c, {
				type: "unauthenticated",
			} satisfies AuthHandler.UnauthenticatedAuthContext);

			return await next();
		}

		return APIResponse.unauthorized(c, "Invalid Authorization header");
	}

	const token = authHeader.substring("Bearer ".length);

	const authContext = await AuthHandler.getAuthContext(token);

	if (!authContext || !(await AuthHandler.isValidAuthContext(authContext))) {
		if (isPublicAuthPath(c.req.path)) {
			AuthHandler.AuthContext.set(c, {
				type: "unauthenticated",
			} satisfies AuthHandler.UnauthenticatedAuthContext);

			return await next();
		}

		return APIResponse.unauthorized(c, "Invalid or expired token");
	}

	AuthHandler.AuthContext.set(c, authContext);

	return await next();
});
