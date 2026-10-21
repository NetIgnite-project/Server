import type { Hooks, Peer } from "crossws";
import { eq } from "drizzle-orm";
import { DB } from "../db";
import { Logger } from "../utils/logger";
import { AgentAuth } from "./auth";
import { AgentConnection, AgentRequestError } from "./connection";
import { AgentProtocol } from "./protocol";
import { AgentCloseCodes, AgentRegistry } from "./registry";

type AgentPeerContext = { agentID?: number; ownerID?: number; kind?: AgentConnection["kind"] };

/**
 * Drives `/ws/agent`: authenticates the upgrade, waits for HELLO, keeps connections alive and
 * dispatches agent events. Live state is in {@link AgentRegistry}.
 */
export class AgentGatewayRunner {
	static readonly HELLO_TIMEOUT_MS = 10_000;
	static readonly KEEPALIVE_INTERVAL_MS = 30_000;
	/** A connection that sent nothing for this long is dropped. */
	static readonly IDLE_TIMEOUT_MS = 75_000;
	/** `last_seen_at` is written at most this often per agent. */
	static readonly LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

	private static keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private static readonly lastSeenWrites = new Map<number, number>();
	private static readonly helloListeners = new Set<(connection: AgentConnection) => void>();
	private static readonly disconnectListeners = new Set<(connection: AgentConnection) => void>();
	private static readonly eventHandlers = new Map<
		string,
		(connection: AgentConnection, payload: Record<string, unknown>) => void | Promise<void>
	>();

	static hooks(): Partial<Hooks> {
		return {
			upgrade: (request) => this.handleUpgrade(request),
			open: (peer) => this.handleOpen(peer),
			message: (peer, message) => this.handleMessage(peer, message.text()),
			close: (peer) => this.handleClose(peer),
			error: (peer, error) => {
				Logger.warn(`Agent WebSocket error (peer ${peer.id}):`, error);
			},
		};
	}

	static start() {
		if (this.keepaliveTimer) return;
		this.keepaliveTimer = setInterval(() => this.keepalive(), this.KEEPALIVE_INTERVAL_MS);
		this.keepaliveTimer.unref?.();
	}

	static stop() {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = null;
		AgentRegistry.disconnectAll(AgentCloseCodes.SERVER_SHUTDOWN, "Server shutting down");
	}

	/** Called whenever an agent finished its HELLO (used by the status service). */
	static onHello(listener: (connection: AgentConnection) => void) {
		this.helloListeners.add(listener);
		return () => this.helloListeners.delete(listener);
	}

	/** Called when an agent's connection closes (not when it was replaced by a newer one). */
	static onDisconnect(listener: (connection: AgentConnection) => void) {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

	/** Registers the handler for an agent event (`evt` frames other than HELLO). */
	static onEvent(
		cmd: string,
		handler: (connection: AgentConnection, payload: Record<string, unknown>) => void | Promise<void>,
	) {
		this.eventHandlers.set(cmd, handler);
	}

	private static async handleUpgrade(request: { headers: Headers; context: AgentPeerContext }) {
		const header = request.headers.get("authorization");
		const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

		const agent = token ? await AgentAuth.authenticate(token) : null;
		if (!agent) {
			return new Response("Missing or invalid agent credentials", { status: 401 });
		}

		request.context.agentID = agent.id;
		request.context.ownerID = agent.owner_id;
		request.context.kind = agent.kind;
	}

	private static handleOpen(peer: Peer) {
		const { agentID, ownerID, kind } = peer.context as AgentPeerContext;
		if (agentID === undefined || ownerID === undefined || kind === undefined) {
			peer.close(1008, "Unauthenticated");
			return;
		}

		const connection = new AgentConnection(agentID, ownerID, kind, peer);
		AgentRegistry.register(connection);
		Logger.debug(`Agent ${agentID} connected, waiting for HELLO`);

		setTimeout(() => {
			if (!connection.hello && !connection.isClosed) {
				AgentRegistry.unregister(connection.peerID);
				connection.close(AgentCloseCodes.INVALID_HELLO, "No HELLO received");
			}
		}, this.HELLO_TIMEOUT_MS).unref?.();
	}

	private static async handleMessage(peer: Peer, text: string) {
		const connection = AgentRegistry.getByPeer(peer.id);
		if (!connection) return;

		const event = connection.handleText(text);
		if (!event) return;

		if (event.cmd === "HELLO") {
			await this.handleHello(connection, event.p);
			return;
		}

		if (!connection.hello) {
			Logger.warn(`Agent ${connection.agentID} sent ${event.cmd} before HELLO`);
			return;
		}

		const handler = this.eventHandlers.get(event.cmd);
		if (!handler) {
			Logger.debug(`Agent ${connection.agentID}: ignored unknown event ${event.cmd}`);
			return;
		}

		try {
			await handler(connection, event.p);
		} catch (error) {
			Logger.error(`Agent ${connection.agentID}: handling ${event.cmd} failed`, error);
		}
	}

	private static async handleHello(connection: AgentConnection, payload: Record<string, unknown>) {
		const hello = AgentProtocol.Hello.safeParse(payload);
		if (!hello.success || hello.data.kind !== connection.kind) {
			AgentRegistry.unregister(connection.peerID);
			connection.close(
				AgentCloseCodes.INVALID_HELLO,
				hello.success
					? "Agent kind doesn't match"
					: `Unsupported HELLO (protocol ${AgentProtocol.VERSION} expected)`,
			);
			return;
		}

		connection.hello = hello.data;

		await DB.instance()
			.update(DB.Tables.agents)
			.set({
				capabilities: hello.data.capabilities,
				version: hello.data.version,
				info: hello.data.info ?? null,
				// Mirrors the last HELLO: new keys after a factory reset, none if SSH isn't offered.
				ssh_keys: hello.data.ssh_keys ?? null,
				last_seen_at: Date.now(),
			})
			.where(eq(DB.Tables.agents.id, connection.agentID));
		this.lastSeenWrites.set(connection.agentID, Date.now());

		Logger.info(`Agent ${connection.agentID} online (${hello.data.kind} ${hello.data.version})`);

		for (const listener of this.helloListeners) {
			try {
				listener(connection);
			} catch (error) {
				Logger.error("HELLO listener failed", error);
			}
		}
	}

	private static async handleClose(peer: Peer) {
		const connection = AgentRegistry.unregister(peer.id);
		if (!connection) return;

		Logger.info(`Agent ${connection.agentID} disconnected`);
		for (const listener of this.disconnectListeners) {
			try {
				listener(connection);
			} catch (error) {
				Logger.error("Disconnect listener failed", error);
			}
		}
		await this.writeLastSeen(connection.agentID, true);
	}

	private static async keepalive() {
		const now = Date.now();

		for (const connection of AgentRegistry.all()) {
			if (now - connection.lastMessageAt > this.IDLE_TIMEOUT_MS) {
				Logger.warn(`Agent ${connection.agentID} unresponsive, closing`);
				AgentRegistry.disconnect(
					connection.agentID,
					AgentCloseCodes.UNRESPONSIVE,
					"No answer to keep-alive",
				);
				continue;
			}

			if (!connection.hello) continue;

			connection
				.request("PING", {}, 10_000)
				.then(() => this.writeLastSeen(connection.agentID))
				.catch((error) => {
					if (!(error instanceof AgentRequestError)) Logger.error("Keep-alive failed", error);
				});
		}
	}

	private static async writeLastSeen(agentID: number, force = false) {
		const now = Date.now();
		const lastWrite = this.lastSeenWrites.get(agentID) ?? 0;
		if (!force && now - lastWrite < this.LAST_SEEN_WRITE_INTERVAL_MS) return;

		this.lastSeenWrites.set(agentID, now);
		try {
			await DB.instance()
				.update(DB.Tables.agents)
				.set({ last_seen_at: now })
				.where(eq(DB.Tables.agents.id, agentID));
		} catch (error) {
			Logger.warn(`Failed to store last_seen_at of agent ${agentID}`, error);
		}
	}
}
