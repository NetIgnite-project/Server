import { Hono } from "hono";
import { type GenerateSpecOptions } from "hono-openapi";
import { AppConstants } from "../../../utils/constants";
import { APIVersionRouter } from "../../utils/apiVersionRouter";
import { DOCS_TAGS } from "./docs";
import { authMiddlewareV1 } from "./middleware/auth";
import { router as accountRouter } from "./routes/account";
import { router as adminRouter } from "./routes/admin";
import { router as agentsRouter } from "./routes/agents";
import { router as authRouter } from "./routes/auth";
import { router as devicesRouter } from "./routes/devices";

const openAPIConfig: Partial<GenerateSpecOptions> = {
	documentation: {
		info: {
			title: `${AppConstants.APP_NAME} API`,
			version: "1.0.0",
			description: `API for ${AppConstants.APP_NAME} Frontend and third-party clients`,
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "Enter your bearer token in the format **Bearer &lt;token&gt;**",
				},
			},
			responses: {
				401: {
					description: "Authentication information is missing or invalid",
				},
			},
		},

		// Disable global security because Scalar could not handle multiple security schemes properly
		security: [
			{
				bearerAuth: [],
			},
		],

		servers: [
			{
				url: `http://localhost:${AppConstants.APP_API_DEFAULT_PORT}/api/v1`,
				description: "Local development server",
			},
			{
				url: `${AppConstants.APP_API_DEFAULT_PROD_URL}/api/v1`,
				description: "Production server",
			},
		],

		"x-tagGroups": [
			{
				name: "Account & Authentication",
				tags: [
					DOCS_TAGS.ACCOUNT,
					DOCS_TAGS.ACCOUNT_API_KEYS,
					DOCS_TAGS.ACCOUNT_PREFERENCES,
					DOCS_TAGS.AUTHENTICATION,
				],
			},
			{
				name: "Agents & Devices",
				tags: [DOCS_TAGS.AGENTS, DOCS_TAGS.DEVICES, DOCS_TAGS.DEVICE_SHARES],
			},
			{
				name: DOCS_TAGS.ADMIN_API.BASE,
				tags: [DOCS_TAGS.ADMIN_API.USERS, DOCS_TAGS.ADMIN_API.SETTINGS],
			},
		],

		tags: [
			{
				name: DOCS_TAGS.ACCOUNT,
				description: "Endpoints for user account management",
			},
			{
				name: DOCS_TAGS.ACCOUNT_API_KEYS,
				// @ts-ignore
				"x-displayName": "API Keys",
				summary: "API Keys",
				parent: DOCS_TAGS.ACCOUNT,
				description: "Endpoints for managing account API keys",
			},
			{
				name: DOCS_TAGS.ACCOUNT_PREFERENCES,
				// @ts-ignore
				"x-displayName": "Preferences",
				summary: "Preferences",
				parent: DOCS_TAGS.ACCOUNT,
				description: "Endpoints for managing account preferences (e.g. remote email content policy)",
			},

			{
				name: DOCS_TAGS.AUTHENTICATION,
				description: "Endpoints for authentication and authorization",
			},

			{
				name: DOCS_TAGS.AGENTS,
				description:
					"Agents (ESP32 firmware, Linux agent) that wake and check devices in their network",
			},
			{
				name: DOCS_TAGS.DEVICES,
				description: "Devices: Wake-on-LAN, status checks, shutdown and reboot",
			},
			{
				name: DOCS_TAGS.DEVICE_SHARES,
				// @ts-ignore
				"x-displayName": "Sharing",
				summary: "Sharing",
				parent: DOCS_TAGS.DEVICES,
				description: "Share devices with other users as viewer, operator or manager",
			},

			{
				name: DOCS_TAGS.ADMIN_API.SETTINGS,
				// @ts-ignore
				"x-displayName": "Settings",
				summary: "Settings",
				parent: DOCS_TAGS.ADMIN_API.BASE,
				description: "Server-wide settings such as public registration",
			},
			{
				name: DOCS_TAGS.ADMIN_API.USERS,
				// @ts-ignore
				"x-displayName": "Users",
				summary: "Users",
				parent: DOCS_TAGS.ADMIN_API.BASE,
				description: "Endpoints for user management",
			},
		],
	},
};

const router = new Hono();

router.use(authMiddlewareV1);

router.route("/", authRouter);
router.route("/", accountRouter);
router.route("/", adminRouter);
router.route("/", agentsRouter);
router.route("/", devicesRouter);

export class APIv1Router extends APIVersionRouter {
	constructor() {
		super({
			version: 1,
			openAPIConfig,
			routes: router,
		});
	}
}
