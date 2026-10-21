import { and, eq, isNull } from "drizzle-orm";
import { AuthUtils } from "../api/utils/authHandler";
import type { AgentSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";
import { AppConstants } from "../utils/constants";
import { AgentCloseCodes, AgentRegistry } from "./registry";

/**
 * Agent credentials.
 *
 * 1. The dashboard creates a single-use enrollment token (`netignite_enroll_<id>:<base>`, 15 minutes)
 *    and hands it to the agent: embedded in the ESP32 flash image, or as `netignite-agent pair`.
 * 2. The agent generates its own secret and calls `POST /v1/agents/enroll`. The server stores only
 *    the secret's hash and returns a token id.
 * 3. The agent then connects with `Authorization: Bearer netignite_agent_<token_id>:<secret>`.
 *
 * The long-term secret never leaves the agent in clear, and enrolling again revokes the old one.
 */
export class AgentAuth {
	static readonly AGENT_TOKEN_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_agent_`;
	static readonly ENROLLMENT_TOKEN_PREFIX = `${AppConstants.APP_KEYS_PREFIX}_enroll_`;

	static readonly ENROLLMENT_TTL_MS = 15 * 60 * 1000;

	/** Agent-generated secrets: 32–128 URL-safe characters (the agents send 64 hex characters). */
	static readonly SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

	/** Creates an enrollment token for the agent and invalidates any older unused one. */
	static async createEnrollment(agentID: number, userID: number) {
		const id = AuthUtils.createRandomTokenID();
		const base = AuthUtils.createBaseToken();
		const hashed_token = await AuthUtils.hashTokenBase(base);
		const expires_at = Date.now() + this.ENROLLMENT_TTL_MS;

		// Synchronous: drizzle's bun-sqlite transaction() commits at the first `await`.
		DB.instance().transaction((tx) => {
			tx
				.delete(DB.Tables.agentEnrollments)
				.where(
					and(
						eq(DB.Tables.agentEnrollments.agent_id, agentID),
						isNull(DB.Tables.agentEnrollments.used_at),
					),
				)
				.run();
			tx
				.insert(DB.Tables.agentEnrollments)
				.values({ id, hashed_token, agent_id: agentID, created_by_user_id: userID, expires_at })
				.run();
		});

		return { token: `${this.ENROLLMENT_TOKEN_PREFIX}${id}:${base}`, expires_at };
	}

	/**
	 * Redeems an enrollment token and stores the agent's new credential. Returns the agent and the
	 * token id it must use from now on, or null if the token is unknown, used or expired.
	 *
	 * With `expectedKind` (sent by current agents), a token of another kind of agent is refused
	 * with `{ wrongKind }` before it is used, so it keeps working for the right device.
	 */
	static async enroll(enrollmentToken: string, secret: string, expectedKind?: AgentSettings.Kind) {
		const parts = this.parseToken(enrollmentToken, this.ENROLLMENT_TOKEN_PREFIX);
		if (!parts || !this.SECRET_PATTERN.test(secret)) return null;

		const enrollment = await DB.instance()
			.select()
			.from(DB.Tables.agentEnrollments)
			.where(eq(DB.Tables.agentEnrollments.id, parts.id))
			.get();

		if (
			!enrollment ||
			enrollment.used_at !== null ||
			enrollment.expires_at < Date.now() ||
			!(await AuthUtils.verifyHashedTokenBase(parts.base, enrollment.hashed_token))
		) {
			return null;
		}

		if (expectedKind) {
			const target = await DB.instance()
				.select({ kind: DB.Tables.agents.kind })
				.from(DB.Tables.agents)
				.where(eq(DB.Tables.agents.id, enrollment.agent_id))
				.get();
			if (target && target.kind !== expectedKind) return { wrongKind: target.kind } as const;
		}

		const tokenID = AuthUtils.createRandomTokenID();
		const hashedSecret = await AuthUtils.hashTokenBase(secret);

		// Synchronous: drizzle's bun-sqlite transaction() commits at the first `await`.
		const agent = DB.instance().transaction((tx) => {
			// Claim the token; a concurrent enrollment with the same token updates no row.
			const claimed = tx
				.update(DB.Tables.agentEnrollments)
				.set({ used_at: Date.now() })
				.where(
					and(
						eq(DB.Tables.agentEnrollments.id, enrollment.id),
						isNull(DB.Tables.agentEnrollments.used_at),
					),
				)
				.returning()
				.get();
			if (!claimed) return null;

			return tx
				.update(DB.Tables.agents)
				.set({ token_id: tokenID, hashed_secret: hashedSecret, enrolled_at: Date.now() })
				.where(eq(DB.Tables.agents.id, enrollment.agent_id))
				.returning()
				.get();
		});

		if (!agent) return null;

		// A previously enrolled device with the old credential must not stay connected.
		AgentRegistry.disconnect(agent.id, AgentCloseCodes.CREDENTIAL_REVOKED, "Agent was re-enrolled");

		return { agent, token_id: tokenID, wrongKind: null };
	}

	/** Resolves an agent credential (`netignite_agent_<token_id>:<secret>`) to its agent. */
	static async authenticate(fullToken: string) {
		const parts = this.parseToken(fullToken, this.AGENT_TOKEN_PREFIX);
		if (!parts) return null;

		const agent = await DB.instance()
			.select()
			.from(DB.Tables.agents)
			.where(eq(DB.Tables.agents.token_id, parts.id))
			.get();

		if (!agent?.hashed_secret) return null;
		if (!(await AuthUtils.verifyHashedTokenBase(parts.base, agent.hashed_secret))) return null;

		return agent;
	}

	/** Removes the agent's credential and pending enrollments, and disconnects it. */
	static revoke(agentID: number) {
		DB.instance().transaction((tx) => {
			tx
				.update(DB.Tables.agents)
				.set({ token_id: null, hashed_secret: null, enrolled_at: null })
				.where(eq(DB.Tables.agents.id, agentID))
				.run();
			tx
				.delete(DB.Tables.agentEnrollments)
				.where(eq(DB.Tables.agentEnrollments.agent_id, agentID))
				.run();
		});

		AgentRegistry.disconnect(agentID, AgentCloseCodes.CREDENTIAL_REVOKED, "Credential revoked");
	}

	private static parseToken(token: string, prefix: string) {
		if (!token.startsWith(prefix)) return null;

		const [id, base, ...rest] = token.slice(prefix.length).split(":");
		if (!id || !base || rest.length > 0) return null;

		return { id, base };
	}
}
