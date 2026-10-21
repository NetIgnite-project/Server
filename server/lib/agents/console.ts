import type { Hooks, Peer } from "crossws";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AuthHandler } from "../api/utils/authHandler";
import { DB } from "../db";
import { ConfigHandler } from "../utils/config";
import { Logger } from "../utils/logger";
import { AgentRequestError } from "./connection";
import { AgentGatewayRunner } from "./gateway";
import { AgentProtocol } from "./protocol";
import { AgentRegistry } from "./registry";

/**
 * `/ws/console`: streams an agent's log to the dashboard.
 *
 * Browsers can't set headers on a WebSocket, so the first message authenticates:
 * `{ "type": "auth", "token": "<session or API key>", "agent_id": 7 }`. Only the agent's owner
 * may watch it (agents are never shared). The token is checked again every minute.
 *
 * Server → browser:
 * - `{ "type": "ready", "online": bool }` after authenticating
 * - `{ "type": "lines", "lines": [...], "reset": bool, "dropped"?: n, "level"?: "info" }`;
 *   `reset` replaces what the browser shows (the agent's stored lines after (re)connecting)
 * - `{ "type": "state", "online": bool }` when the agent connects or disconnects
 * - `{ "type": "error", "message": "..." }`, then the connection closes
 *
 * While at least one browser watches an online agent, the agent is subscribed (`LOG_SUBSCRIBE`).
 */
export class ConsoleRelay {
	static readonly AUTH_TIMEOUT_MS = 10_000;
	static readonly REVALIDATE_INTERVAL_MS = 60_000;

	private static readonly viewers = new Map<string, ConsoleRelay.Viewer>();
	private static initialized = false;
	private static revalidateTimer: ReturnType<typeof setInterval> | null = null;

	static readonly CloseCodes = {
		UNAUTHORIZED: 4401,
		NOT_FOUND: 4404,
		POLICY: 1008,
	} as const;

	static init() {
		if (this.initialized) return;
		this.initialized = true;

		AgentGatewayRunner.onEvent("LOG", (connection, payload) => {
			const event = AgentProtocol.LogEvent.safeParse(payload);
			if (!event.success) return;
			this.broadcast(connection.agentID, {
				type: "lines",
				lines: event.data.lines,
				reset: false,
				...(event.data.dropped ? { dropped: event.data.dropped } : {}),
			});
		});
		AgentGatewayRunner.onHello((connection) => {
			if (this.viewersOf(connection.agentID).length === 0) return;
			this.broadcast(connection.agentID, { type: "state", online: true });
			void this.subscribe(connection.agentID);
		});
		AgentGatewayRunner.onDisconnect((connection) => {
			this.broadcast(connection.agentID, { type: "state", online: false });
		});

		this.revalidateTimer = setInterval(() => void this.revalidate(), this.REVALIDATE_INTERVAL_MS);
		this.revalidateTimer.unref?.();
	}

	static stop() {
		if (this.revalidateTimer) clearInterval(this.revalidateTimer);
		this.revalidateTimer = null;
		for (const viewer of this.viewers.values()) viewer.peer.close(1001, "Server shutting down");
		this.viewers.clear();
	}

	static hooks(): Partial<Hooks> {
		return {
			upgrade: (request) => {
				// Only the dashboard itself may open a console (no cross-site WebSocket hijacking).
				const origin = request.headers.get("origin");
				const appURL = ConfigHandler.getConfig()?.APP_URL;
				if (origin && appURL && origin !== new URL(appURL).origin) {
					return new Response("Origin not allowed", { status: 403 });
				}
			},
			open: (peer) => {
				this.viewers.set(peer.id, { peer, token: null, userID: null, agentID: null });
				setTimeout(() => {
					const viewer = this.viewers.get(peer.id);
					if (viewer && viewer.agentID === null)
						this.reject(viewer, this.CloseCodes.UNAUTHORIZED, "Not authenticated");
				}, this.AUTH_TIMEOUT_MS).unref?.();
			},
			message: (peer, message) => this.handleMessage(peer, message.text()),
			close: (peer) => this.handleClose(peer),
			error: (peer, error) => Logger.warn(`Console WebSocket error (peer ${peer.id}):`, error),
		};
	}

	private static async handleMessage(peer: Peer, text: string) {
		const viewer = this.viewers.get(peer.id);
		if (!viewer) return;
		if (viewer.agentID !== null) return; // nothing else is accepted after authenticating

		let message: z.infer<typeof AuthMessage>;
		try {
			const parsed = AuthMessage.safeParse(JSON.parse(text));
			if (!parsed.success)
				return this.reject(viewer, this.CloseCodes.POLICY, "Expected an auth message");
			message = parsed.data;
		} catch {
			return this.reject(viewer, this.CloseCodes.POLICY, "Expected an auth message");
		}

		const auth = await AuthHandler.getAuthContext(message.token);
		if (!auth || !(await AuthHandler.isValidAuthContext(auth))) {
			return this.reject(viewer, this.CloseCodes.UNAUTHORIZED, "Invalid or expired token");
		}

		const agent = await DB.instance()
			.select({ id: DB.Tables.agents.id })
			.from(DB.Tables.agents)
			.where(
				and(eq(DB.Tables.agents.id, message.agent_id), eq(DB.Tables.agents.owner_id, auth.user_id)),
			)
			.get();
		if (!agent) return this.reject(viewer, this.CloseCodes.NOT_FOUND, "Agent not found");

		viewer.token = message.token;
		viewer.userID = auth.user_id;
		viewer.agentID = agent.id;

		const online = AgentRegistry.isOnline(agent.id);
		this.send(viewer, { type: "ready", online });
		if (online) await this.subscribe(agent.id, viewer);
	}

	private static handleClose(peer: Peer) {
		const viewer = this.viewers.get(peer.id);
		this.viewers.delete(peer.id);
		if (viewer?.agentID == null || this.viewersOf(viewer.agentID).length > 0) return;

		// The last viewer left: stop the agent's stream.
		AgentRegistry.get(viewer.agentID)
			?.request("LOG_SUBSCRIBE", { enabled: false })
			.catch(() => {});
	}

	/**
	 * Subscribes the agent and sends its stored lines to `only`, or to every viewer (after the
	 * agent reconnected).
	 */
	private static async subscribe(agentID: number, only?: ConsoleRelay.Viewer) {
		const connection = AgentRegistry.get(agentID);
		if (!connection?.hasCapability("logs")) return;

		try {
			const result = await connection.request("LOG_SUBSCRIBE", { enabled: true }, 10_000);
			const message = {
				type: "lines",
				lines: result.lines ?? [],
				reset: true,
				...(result.level ? { level: result.level } : {}),
			};
			if (only) this.send(only, message);
			else this.broadcast(agentID, message);
		} catch (error) {
			if (!(error instanceof AgentRequestError))
				Logger.warn(`Agent ${agentID}: log subscription failed`, error);
		}
	}

	private static async revalidate() {
		for (const viewer of this.viewers.values()) {
			if (!viewer.token) continue;
			const auth = await AuthHandler.getAuthContext(viewer.token);
			if (!auth || auth.user_id !== viewer.userID || !(await AuthHandler.isValidAuthContext(auth))) {
				this.reject(viewer, this.CloseCodes.UNAUTHORIZED, "Session expired");
			}
		}
	}

	private static viewersOf(agentID: number) {
		return [...this.viewers.values()].filter((viewer) => viewer.agentID === agentID);
	}

	private static broadcast(agentID: number, message: Record<string, unknown>) {
		for (const viewer of this.viewersOf(agentID)) this.send(viewer, message);
	}

	private static send(viewer: ConsoleRelay.Viewer, message: Record<string, unknown>) {
		try {
			viewer.peer.send(JSON.stringify(message));
		} catch {
			// Closing.
		}
	}

	private static reject(viewer: ConsoleRelay.Viewer, code: number, message: string) {
		this.send(viewer, { type: "error", message });
		this.viewers.delete(viewer.peer.id);
		try {
			viewer.peer.close(code, message);
		} catch {
			// Already closed.
		}
	}
}

export namespace ConsoleRelay {
	export interface Viewer {
		peer: Peer;
		/** Kept to check the session again while the console is open. */
		token: string | null;
		userID: number | null;
		agentID: number | null;
	}
}

const AuthMessage = z.object({
	type: z.literal("auth"),
	token: z.string().min(1).max(512),
	agent_id: z.number().int().positive(),
});
