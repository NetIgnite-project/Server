import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { AgentAuth } from "../../../../../agents/auth";
import { AgentRequestError } from "../../../../../agents/connection";
import type { AgentProtocol } from "../../../../../agents/protocol";
import { AgentCloseCodes, AgentRegistry } from "../../../../../agents/registry";
import { DB } from "../../../../../db";
import { FirmwareCatalog } from "../../../../../firmware/catalog";
import { OtaError, OtaService } from "../../../../../firmware/ota";
import { ProvisioningImage } from "../../../../../firmware/provisioning";
import { ConfigHandler } from "../../../../../utils/config";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { getUserID, requireUser } from "../../middleware/requireUser";
import { AgentsModel } from "./model";

export const router = new Hono().basePath("/agents");

/**
 * `recommended`: the recommended firmware version, to fill `update_available` (list and detail
 * responses pass it).
 */
export function toAgentResponse(
	agent: DB.Models.Agent,
	recommended: string | null = null,
): AgentsModel.Agent {
	const canUpdate = agent.kind === "esp32" && agent.capabilities.includes("ota");
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		kind: agent.kind,
		state:
			agent.token_id === null ? "unenrolled" : AgentRegistry.isOnline(agent.id) ? "online" : "offline",
		version: agent.version,
		capabilities: agent.capabilities,
		info: agent.info,
		last_seen_at: agent.last_seen_at,
		enrolled_at: agent.enrolled_at,
		created_at: agent.created_at,
		update: OtaService.get(agent.id),
		update_available:
			canUpdate && recommended && FirmwareCatalog.isNewer(recommended, agent.version)
				? recommended
				: null,
	};
}

/** Answers a failed agent request like the device actions do. */
function agentRequestError(c: Context, error: unknown) {
	if (!(error instanceof AgentRequestError)) throw error;
	switch (error.reason) {
		case "unsupported":
			return APIResponse.conflict(c, "This agent doesn't support that");
		case "rejected":
			return APIResponse.badGateway(c, error.message);
		case "offline":
			return APIResponse.serviceUnavailable(c, "The agent is offline");
		case "timeout":
			return APIResponse.gatewayTimeout(c, "The agent didn't answer in time");
	}
}

/** Sends a request to the agent's live connection. */
function requestAgent<C extends AgentProtocol.Command>(
	agentID: number,
	cmd: C,
	payload: AgentProtocol.Commands[C]["req"],
	timeoutMs?: number,
) {
	const connection = AgentRegistry.get(agentID);
	if (!connection) {
		return Promise.reject(new AgentRequestError("offline", "The agent is offline"));
	}
	return connection.request(cmd, payload, timeoutMs);
}

const AGENT_REQUEST_ERRORS = [
	APIResponseSpec.conflict("The agent doesn't support this"),
	APIResponseSpec.badGateway("The agent reported an error"),
	APIResponseSpec.serviceUnavailable("The agent is offline"),
	APIResponseSpec.gatewayTimeout("The agent didn't answer in time"),
] as const;

// --- Enrollment (called by agents, no user authentication) --------------------------------------

const ENROLL_WINDOW_MS = 5 * 60 * 1000;
const ENROLL_MAX_ATTEMPTS = 20;
const enrollAttempts = new Map<string, { count: number; resetAt: number }>();

/** For tests, which enroll more agents than one client may. */
export function resetEnrollRateLimit() {
	enrollAttempts.clear();
}

function registerEnrollAttempt(c: Context) {
	// @ts-ignore bun/hono provides a native request with connection info
	const client = (c.req.raw as any)?.remoteAddr?.hostname ?? "unknown";
	const now = Date.now();

	let entry = enrollAttempts.get(client);
	if (!entry || entry.resetAt <= now) {
		entry = { count: 0, resetAt: now + ENROLL_WINDOW_MS };
		enrollAttempts.set(client, entry);
	}
	entry.count += 1;
	return entry.count <= ENROLL_MAX_ATTEMPTS;
}

router.post(
	"/enroll",

	APIRouteSpec.unauthenticated({
		summary: "Enroll an agent",
		description:
			"Called by an agent with its single-use enrollment token and a secret it generated itself. " +
			"Returns the token id the agent connects with: `Authorization: Bearer netignite_agent_<token_id>:<secret>`.",
		tags: [DOCS_TAGS.AGENTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Agent enrolled", AgentsModel.Enroll.Response),
			APIResponseSpec.unauthorized("Unauthorized: Unknown, used or expired enrollment token"),
			APIResponseSpec.conflict("The token is for another kind of agent (it stays valid)"),
			APIResponseSpec.tooManyRequests("Too many enrollment attempts"),
		),
	}),

	validator("json", AgentsModel.Enroll.Body),

	async (c) => {
		if (!registerEnrollAttempt(c)) {
			return APIResponse.tooManyRequests(c, "Too many enrollment attempts, try again later");
		}

		const { enrollment_token, secret, kind } = c.req.valid("json");
		if (!AgentAuth.SECRET_PATTERN.test(secret)) {
			return APIResponse.badRequest(
				c,
				"The secret must be 32–128 characters of A-Z, a-z, 0-9, _ and -",
			);
		}

		const result = await AgentAuth.enroll(enrollment_token, secret, kind);
		if (!result) {
			return APIResponse.unauthorized(c, "Unknown, used or expired enrollment token");
		}
		if (result.wrongKind) {
			return APIResponse.conflict(
				c,
				`This enrollment token is for ${result.wrongKind === "esp32" ? "an ESP32" : "a Linux"} agent. ` +
					"Create the token on the page of this agent.",
			);
		}

		Logger.info(`Agent ${result.agent.id} enrolled`);
		return APIResponse.success(c, "Agent enrolled", {
			agent_id: result.agent.id,
			kind: result.agent.kind,
			token_id: result.token_id,
		} satisfies AgentsModel.Enroll.Response);
	},
);

// --- Management (the owner's agents) -----------------------------------------------------------

router.use("*", async (c, next) => {
	if (c.req.path.endsWith("/agents/enroll")) return await next();
	return await requireUser(c, next);
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List agents",
		description: "All agents of the authenticated user. Agents are never shared.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Agents retrieved", AgentsModel.Agent.array()),
		),
	}),

	async (c) => {
		const agents = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.owner_id, getUserID(c)))
			.orderBy(DB.Tables.agents.name);

		const recommended = (await FirmwareCatalog.recommendedRelease())?.version ?? null;
		return APIResponse.success(
			c,
			"Agents retrieved",
			agents.map((agent) => toAgentResponse(agent, recommended)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create an agent",
		description: "Creates an agent. It can connect once it has been enrolled.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.created("Agent created", AgentsModel.Agent),
		),
	}),

	validator("json", AgentsModel.Create.Body),

	async (c) => {
		const body = c.req.valid("json");

		const agent = await DB.instance()
			.insert(DB.Tables.agents)
			.values({ ...body, owner_id: getUserID(c) })
			.returning()
			.get();

		return APIResponse.created(c, "Agent created", toAgentResponse(agent));
	},
);

router.post(
	"/bulk-update",

	APIRouteSpec.authenticated({
		summary: "Update the firmware of several agents",
		description:
			"Updates the caller's ESP32 agents one after another (each update has to finish first) to the " +
			"given or the recommended release. Offline agents and agents that already run it are skipped. " +
			"Follow the progress in each agent's `update`.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.accepted("Updates queued", AgentsModel.BulkUpdate.Response),
			APIResponseSpec.notFound("Firmware release not found"),
		),
	}),

	validator("json", AgentsModel.BulkUpdate.Body),

	async (c) => {
		const body = c.req.valid("json");
		const release = body.version
			? await FirmwareCatalog.get(body.version)
			: await FirmwareCatalog.recommendedRelease();
		if (!release) return APIResponse.notFound(c, "Firmware release not found");

		const agents = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.owner_id, getUserID(c)));
		const byID = new Map(agents.map((agent) => [agent.id, agent]));

		const queued: DB.Models.Agent[] = [];
		const skipped: AgentsModel.BulkUpdate.Response["skipped"] = [];
		for (const id of new Set(body.agent_ids)) {
			const agent = byID.get(id);
			const connection = agent ? AgentRegistry.get(agent.id) : null;
			const current = agent ? OtaService.get(agent.id) : null;
			const reason = !agent
				? "Agent not found"
				: agent.kind !== "esp32"
					? "Not an ESP32 agent"
					: !connection
						? "Offline"
						: !connection.hasCapability("ota")
							? "Its firmware can't be updated over the network"
							: connection.hello?.version === release.version
								? "Already up to date"
								: current && OtaService.isRunning(current)
									? "An update is already running"
									: null;
			if (reason || !agent) skipped.push({ agent_id: id, reason: reason ?? "Agent not found" });
			else queued.push(agent);
		}

		OtaService.startMany(queued, release);
		return APIResponse.accepted(c, "Updates queued", {
			version: release.version,
			queued: queued.map((agent) => agent.id),
			skipped,
		} satisfies AgentsModel.BulkUpdate.Response);
	},
);

const AgentParam = z.object({ agentID: z.coerce.number().int().positive() });

/** Resolves `:agentID` to an agent of the caller, or answers 404. */
router.use("/:agentID/*", validator("param", AgentParam), async (c, next) => {
	// @ts-ignore set by the validator above
	const { agentID } = c.req.valid("param") as z.infer<typeof AgentParam>;

	const agent = await DB.instance()
		.select()
		.from(DB.Tables.agents)
		.where(and(eq(DB.Tables.agents.id, agentID), eq(DB.Tables.agents.owner_id, getUserID(c))))
		.get();

	if (!agent) return APIResponse.notFound(c, "Agent not found");

	// @ts-ignore
	c.set("agent", agent);
	await next();
});

function getAgent(c: Context) {
	// @ts-ignore set by the middleware above
	return c.get("agent") as DB.Models.Agent;
}

router.get(
	"/:agentID",

	APIRouteSpec.authenticated({
		summary: "Get an agent",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Agent retrieved", AgentsModel.Agent),
			APIResponseSpec.notFound("Agent not found"),
		),
	}),

	async (c) => {
		const recommended = (await FirmwareCatalog.recommendedRelease())?.version ?? null;
		return APIResponse.success(c, "Agent retrieved", toAgentResponse(getAgent(c), recommended));
	},
);

router.put(
	"/:agentID",

	APIRouteSpec.authenticated({
		summary: "Update an agent",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Agent updated", AgentsModel.Agent),
			APIResponseSpec.notFound("Agent not found"),
		),
	}),

	validator("json", AgentsModel.Update.Body),

	async (c) => {
		const agent = await DB.instance()
			.update(DB.Tables.agents)
			.set(c.req.valid("json"))
			.where(eq(DB.Tables.agents.id, getAgent(c).id))
			.returning()
			.get();

		return APIResponse.success(c, "Agent updated", toAgentResponse(agent));
	},
);

router.delete(
	"/:agentID",

	APIRouteSpec.authenticated({
		summary: "Delete an agent",
		description:
			"Disconnects and deletes the agent. Devices that used it keep their settings but have no agent.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Agent deleted"),
			APIResponseSpec.notFound("Agent not found"),
		),
	}),

	async (c) => {
		const agent = getAgent(c);

		await DB.instance().delete(DB.Tables.agents).where(eq(DB.Tables.agents.id, agent.id));
		AgentRegistry.disconnect(agent.id, AgentCloseCodes.DELETED, "Agent deleted");

		return APIResponse.successNoData(c, "Agent deleted");
	},
);

router.post(
	"/:agentID/enrollments",

	APIRouteSpec.authenticated({
		summary: "Create an enrollment token",
		description:
			"Creates a single-use enrollment token (valid 15 minutes) for `netignite-agent pair`. Older unused " +
			"tokens of the agent stop working. Enrolling replaces the agent's current credential.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Enrollment token created", AgentsModel.Enrollment.Response),
			APIResponseSpec.notFound("Agent not found"),
		),
	}),

	async (c) => {
		const enrollment = await AgentAuth.createEnrollment(getAgent(c).id, getUserID(c));
		return APIResponse.created(
			c,
			"Enrollment token created",
			enrollment satisfies AgentsModel.Enrollment.Response,
		);
	},
);

router.post(
	"/:agentID/revoke",

	APIRouteSpec.authenticated({
		summary: "Revoke an agent's credential",
		description: "Disconnects the agent. It can only connect again after a new enrollment.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Credential revoked", AgentsModel.Agent),
			APIResponseSpec.notFound("Agent not found"),
		),
	}),

	async (c) => {
		const agent = getAgent(c);
		AgentAuth.revoke(agent.id);

		const updated = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.id, agent.id))
			.get();
		return APIResponse.success(c, "Credential revoked", toAgentResponse(updated ?? agent));
	},
);

router.post(
	"/:agentID/flash-image",

	APIRouteSpec.authenticated({
		summary: "Create an ESP32 flash image",
		description:
			"Creates the NVS image the web installer flashes together with the firmware: the server URL, the " +
			"agent's name and a new single-use enrollment token (valid 15 minutes; older unused tokens stop " +
			"working). The agent enrolls with it on its first connection, which replaces its current credential.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.created("Flash image created", AgentsModel.FlashImage.Response),
			APIResponseSpec.notFound("Agent or firmware release not found"),
		),
	}),

	validator("json", AgentsModel.FlashImage.Body),

	async (c) => {
		const agent = getAgent(c);
		if (agent.kind !== "esp32") {
			return APIResponse.badRequest(c, "Only ESP32 agents are installed from the browser");
		}

		const body = c.req.valid("json");
		const release = await FirmwareCatalog.get(body.version);
		if (!release) return APIResponse.notFound(c, "Firmware release not found");
		if (!ProvisioningImage.supports(release.manifest)) {
			return APIResponse.badRequest(
				c,
				`Firmware ${release.version} can't be set up by the web installer`,
			);
		}

		const appURL = ConfigHandler.getConfig()?.APP_URL ?? "";
		const serverURL = (body.server_url ?? appURL).replace(/\/$/, "");
		const enrollment = await AgentAuth.createEnrollment(agent.id, getUserID(c));
		const image = ProvisioningImage.build(release.manifest, {
			server: serverURL,
			enroll: enrollment.token,
			name: agent.name,
		});

		// The image holds a credential: never cache it.
		c.header("Cache-Control", "no-store");
		return APIResponse.created(c, "Flash image created", {
			image: Buffer.from(image).toString("base64"),
			offset: release.manifest.nvs.offset,
			server_url: serverURL,
			expires_at: enrollment.expires_at,
		} satisfies AgentsModel.FlashImage.Response);
	},
);

// --- Firmware updates, console and device control (ESP32) ----------------------------------------

router.post(
	"/:agentID/update",

	APIRouteSpec.authenticated({
		summary: "Update an agent's firmware",
		description:
			"Starts an OTA update to the given or the recommended release. The agent downloads and checks the " +
			"image, restarts, and goes back to its previous firmware if the new one doesn't reach the server. " +
			"Follow the progress in the agent's `update`.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.accepted("Update started", AgentsModel.FirmwareUpdate),
			APIResponseSpec.notFound("Agent or firmware release not found"),
			APIResponseSpec.conflict("The agent can't be updated now"),
			APIResponseSpec.badGateway("The agent couldn't start the update"),
			APIResponseSpec.serviceUnavailable("The agent is offline"),
		),
	}),

	validator("json", AgentsModel.StartUpdate.Body),

	async (c) => {
		const agent = getAgent(c);
		if (agent.kind !== "esp32") {
			return APIResponse.badRequest(c, "Only ESP32 agents are updated by NetIgnite");
		}

		const { version } = c.req.valid("json");
		const release = version
			? await FirmwareCatalog.get(version)
			: await FirmwareCatalog.recommendedRelease();
		if (!release) return APIResponse.notFound(c, "Firmware release not found");

		try {
			const update = await OtaService.start(agent, release);
			return APIResponse.accepted(c, "Update started", update);
		} catch (error) {
			if (!(error instanceof OtaError)) throw error;
			switch (error.reason) {
				case "offline":
					return APIResponse.serviceUnavailable(c, error.message);
				case "rejected":
					return APIResponse.badGateway(c, error.message);
				default:
					return APIResponse.conflict(c, error.message);
			}
		}
	},
);

router.get(
	"/:agentID/logs",

	APIRouteSpec.authenticated({
		summary: "Get an agent's log",
		description:
			"The agent's most recent log lines. For a live view, use the `/ws/console` WebSocket.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Log retrieved", AgentsModel.Logs.Response),
			APIResponseSpec.notFound("Agent not found"),
			...AGENT_REQUEST_ERRORS,
		),
	}),

	async (c) => {
		try {
			const result = await requestAgent(getAgent(c).id, "GET_LOGS", {});
			return APIResponse.success(c, "Log retrieved", {
				lines: result.lines ?? [],
				level: result.level ?? null,
			} satisfies AgentsModel.Logs.Response);
		} catch (error) {
			return agentRequestError(c, error);
		}
	},
);

router.get(
	"/:agentID/info",

	APIRouteSpec.authenticated({
		summary: "Get an agent's current diagnostics",
		description: "Asks the agent for its current state (network, memory, uptime, firmware).",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Info retrieved", AgentsModel.Info.Response),
			APIResponseSpec.notFound("Agent not found"),
			...AGENT_REQUEST_ERRORS,
		),
	}),

	async (c) => {
		const agent = getAgent(c);
		try {
			const result = await requestAgent(agent.id, "GET_INFO", {});
			if (result.info) {
				await DB.instance()
					.update(DB.Tables.agents)
					.set({ info: result.info })
					.where(eq(DB.Tables.agents.id, agent.id));
			}
			return APIResponse.success(c, "Info retrieved", {
				version: result.version ?? null,
				info: result.info ?? {},
			} satisfies AgentsModel.Info.Response);
		} catch (error) {
			return agentRequestError(c, error);
		}
	},
);

router.put(
	"/:agentID/device-config",

	APIRouteSpec.authenticated({
		summary: "Change an agent's settings",
		description:
			"Changes settings stored on the agent. A new server URL or IP setting is only kept if the agent " +
			"reaches the server with it within 2 minutes; otherwise it restarts with the previous settings. " +
			"Wi-Fi is changed over USB with the web installer (Improv), never through the server.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Settings sent to the agent"),
			APIResponseSpec.notFound("Agent not found"),
			...AGENT_REQUEST_ERRORS,
		),
	}),

	validator("json", AgentsModel.DeviceConfig.Body),

	async (c) => {
		try {
			await requestAgent(getAgent(c).id, "CONFIG_SET", c.req.valid("json"));
			return APIResponse.successNoData(c, "Settings sent to the agent");
		} catch (error) {
			return agentRequestError(c, error);
		}
	},
);

router.post(
	"/:agentID/reboot",

	APIRouteSpec.authenticated({
		summary: "Restart an agent",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("The agent restarts"),
			APIResponseSpec.notFound("Agent not found"),
			...AGENT_REQUEST_ERRORS,
		),
	}),

	async (c) => {
		try {
			await requestAgent(getAgent(c).id, "REBOOT", {});
			return APIResponse.successNoData(c, "The agent restarts");
		} catch (error) {
			return agentRequestError(c, error);
		}
	},
);

router.post(
	"/:agentID/factory-reset",

	APIRouteSpec.authenticated({
		summary: "Factory-reset an agent",
		description:
			"Erases the agent's Wi-Fi, server and credential and restarts it. Its credential is revoked here " +
			"too; set it up again with the web installer.",
		tags: [DOCS_TAGS.AGENTS],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("The agent was reset", AgentsModel.Agent),
			APIResponseSpec.notFound("Agent not found"),
			...AGENT_REQUEST_ERRORS,
		),
	}),

	async (c) => {
		const agent = getAgent(c);
		try {
			await requestAgent(agent.id, "FACTORY_RESET", {});
		} catch (error) {
			return agentRequestError(c, error);
		}

		AgentAuth.revoke(agent.id);
		const updated = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.id, agent.id))
			.get();
		return APIResponse.success(c, "The agent was reset", toAgentResponse(updated ?? agent));
	},
);
