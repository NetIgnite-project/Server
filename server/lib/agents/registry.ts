import type { AgentConnection } from "./connection";

/** WebSocket close codes the server uses for agents. */
export const AgentCloseCodes = {
	SERVER_SHUTDOWN: 1001,
	/** The same agent connected again; the older connection is dropped. */
	REPLACED: 4000,
	/** No HELLO after connecting, or an invalid one. */
	INVALID_HELLO: 4001,
	/** Keep-alive pings went unanswered. */
	UNRESPONSIVE: 4002,
	/** The agent was re-enrolled; its old credential no longer works. */
	CREDENTIAL_REVOKED: 4003,
	/** The agent was deleted. */
	DELETED: 4004,
} as const;

/** Live agent connections, by agent id and by WebSocket peer id. */
export class AgentRegistry {
	private static readonly byAgent = new Map<number, AgentConnection>();
	private static readonly byPeer = new Map<string, AgentConnection>();

	/** Adds a connection. An existing connection of the same agent is closed first. */
	static register(connection: AgentConnection) {
		const previous = this.byAgent.get(connection.agentID);
		if (previous) {
			this.unregister(previous.peerID);
			previous.close(AgentCloseCodes.REPLACED, "Replaced by a new connection");
		}

		this.byAgent.set(connection.agentID, connection);
		this.byPeer.set(connection.peerID, connection);
	}

	/** Removes a connection (it is already closing). Returns it, or null if it was replaced earlier. */
	static unregister(peerID: string) {
		const connection = this.byPeer.get(peerID);
		if (!connection) return null;

		this.byPeer.delete(peerID);
		if (this.byAgent.get(connection.agentID) === connection) {
			this.byAgent.delete(connection.agentID);
		}
		connection.detach();
		return connection;
	}

	static getByPeer(peerID: string) {
		return this.byPeer.get(peerID) ?? null;
	}

	/** The agent's connection, once it has sent a valid HELLO. */
	static get(agentID: number) {
		const connection = this.byAgent.get(agentID);
		return connection?.hello && !connection.isClosed ? connection : null;
	}

	static isOnline(agentID: number) {
		return this.get(agentID) !== null;
	}

	static all() {
		return [...this.byAgent.values()];
	}

	static disconnect(agentID: number, code: number, reason: string) {
		const connection = this.byAgent.get(agentID);
		if (!connection) return;

		this.unregister(connection.peerID);
		connection.close(code, reason);
	}

	static disconnectAll(code: number, reason: string) {
		for (const connection of this.all()) {
			this.disconnect(connection.agentID, code, reason);
		}
	}
}
