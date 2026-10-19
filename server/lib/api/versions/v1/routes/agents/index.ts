import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { AgentAuth } from "../../../../../agents/auth";
import { AgentCloseCodes, AgentRegistry } from "../../../../../agents/registry";
import { DB } from "../../../../../db";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { getUserID, requireUser } from "../../middleware/requireUser";
import { AgentsModel } from "./model";

export const router = new Hono().basePath("/agents");

export function toAgentResponse(agent: DB.Models.Agent): AgentsModel.Agent {
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
	};
}

// --- Enrollment (called by agents, no user authentication) --------------------------------------

const ENROLL_WINDOW_MS = 5 * 60 * 1000;
const ENROLL_MAX_ATTEMPTS = 20;
const enrollAttempts = new Map<string, { count: number; resetAt: number }>();

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
			APIResponseSpec.tooManyRequests("Too many enrollment attempts"),
		),
	}),

	validator("json", AgentsModel.Enroll.Body),

	async (c) => {
		if (!registerEnrollAttempt(c)) {
			return APIResponse.tooManyRequests(c, "Too many enrollment attempts, try again later");
		}

		const { enrollment_token, secret } = c.req.valid("json");
		if (!AgentAuth.SECRET_PATTERN.test(secret)) {
			return APIResponse.badRequest(
				c,
				"The secret must be 32–128 characters of A-Z, a-z, 0-9, _ and -",
			);
		}

		const result = await AgentAuth.enroll(enrollment_token, secret);
		if (!result) {
			return APIResponse.unauthorized(c, "Unknown, used or expired enrollment token");
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

		return APIResponse.success(c, "Agents retrieved", agents.map(toAgentResponse));
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

	async (c) => APIResponse.success(c, "Agent retrieved", toAgentResponse(getAgent(c))),
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
