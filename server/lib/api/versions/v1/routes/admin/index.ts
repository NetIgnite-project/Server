import { Hono } from "hono";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";

export const router = new Hono().basePath("/admin");

router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (authContext.type === "unauthenticated") {
		return APIResponse.unauthorized(c, "Authentication required");
	}

	if (authContext.user_role !== "admin") {
		return APIResponse.forbidden(c, "This endpoint is restricted to administrators");
	}

	await next();
});

router.route("/", (await import("./users")).router);
router.route("/", (await import("./settings")).router);
router.route("/", (await import("./firmware")).router);
