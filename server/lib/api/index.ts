import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import { openAPIRouteHandler } from "hono-openapi";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";
import type { APIVersionRouter } from "./utils/apiVersionRouter";
import { APIv1Router } from "./versions/v1";

export class API {
	protected static server: Bun.Server<undefined> | null = null;
	protected static app: Hono | null;

	protected static latestVersion: number | null = null;

	protected static registerVersion(versionRouter: APIVersionRouter, disableDocs: boolean) {
		if (!this.app) {
			throw new Error("API not initialized. Call API.init() first.");
		}

		this.app.route(`/v${versionRouter.version}`, versionRouter.router);

		if (!this.latestVersion || versionRouter.version > this.latestVersion) {
			this.latestVersion = versionRouter.version;
		}

		if (!disableDocs) {
			this.app.get(
				`/docs/v${versionRouter.version}/openapi`,
				openAPIRouteHandler(versionRouter.router, versionRouter.openAPIConfig),
			);

			this.app.get(
				`/docs/v${versionRouter.version}`,
				// Relative, so the docs page also finds its spec when the API is mounted under a prefix.
				Scalar({ url: `./v${versionRouter.version}/openapi` }),
			);
		}
	}

	/**
	 * Build the Hono app: prettyJSON, CORS (allow the frontend origins), error handler,
	 * versioned routes, docs, /health, and a `/` redirect to the latest docs. Does NOT
	 * call Bun.serve — call `start(port, hostname)` for that.
	 */
	static async init(frontendUrls: string[], disableDocs: boolean) {
		this.app = new Hono();

		this.app.use(prettyJSON());

		this.app.use(
			"*",
			cors({
				origin: frontendUrls,
				allowHeaders: ["Content-Type", "Authorization"],
				allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
				maxAge: 600,
				credentials: true,
			}),
		);

		this.app.onError((err, c) => {
			if (err instanceof HTTPException) {
				// Return only safe error metadata — never leak Zod validation details
				return c.json(
					{
						success: false,
						code: err.status,
						message: "Your input is invalid",
					},
					err.status,
				);
			}

			Logger.error("Unhandled API error:", err);
			return c.json({ success: false, code: 500, message: "Internal Server Error" }, 500);
		});

		this.registerVersion(new APIv1Router(), disableDocs);

		this.app.get("/health", (c) => {
			return c.json({
				success: true,
				code: 200,
				message: `${AppConstants.APP_NAME} API is running`,
				data: null,
			});
		});

		if (!disableDocs) {
			this.app.get("/", (c) => {
				// Keep any mount prefix (e.g. `/api` in the full-stack template).
				const base = c.req.path.endsWith("/") ? c.req.path.slice(0, -1) : c.req.path;
				return c.redirect(`${base}/docs/v${this.latestVersion}`);
			});
		} else {
			this.app.get("/", (c) => {
				return c.json({
					success: true,
					code: 200,
					message: `${AppConstants.APP_NAME} API is running. Documentation is disabled.`,
					data: null,
				});
			});
		}
	}

	static async start(port: number, hostname: string) {
		if (!this.app) {
			throw new Error(`${AppConstants.APP_NAME} API not initialized. Call API.init() first.`);
		}

		this.server = Bun.serve({ port, hostname, fetch: this.app.fetch });

		const serverHostnameStr = this.server.hostname?.includes(":")
			? `[${this.server.hostname}]`
			: this.server.hostname;

		Logger.log(
			`${AppConstants.APP_NAME} API listening on ${this.server.protocol}://${serverHostnameStr}:${this.server.port}`,
		);
	}

	static async stop() {
		if (this.server) {
			this.server.stop();
			Logger.log(`${AppConstants.APP_NAME} API server stopped.`);
		}
	}

	static getApp(): Hono {
		if (!this.app) {
			throw new Error(`${AppConstants.APP_NAME} API not initialized. Call API.init() first.`);
		}
		return this.app;
	}
}
