import { randomInt } from "node:crypto";
import type { Peer } from "crossws";
import type { AgentSettings } from "../api/utils/shared-models/netigniteData";
import { Logger } from "../utils/logger";
import { AgentProtocol } from "./protocol";

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class AgentRequestError extends Error {
	constructor(
		readonly reason: AgentRequestError.Reason,
		message: string,
	) {
		super(message);
	}
}

export namespace AgentRequestError {
	/**
	 * - `offline`: the agent isn't connected (or disconnected while the request was pending)
	 * - `unsupported`: the agent didn't advertise the capability
	 * - `timeout`: no answer in time
	 * - `rejected`: the agent answered with `ok: false`
	 */
	export type Reason = "offline" | "unsupported" | "timeout" | "rejected";
}

type PendingRequest = {
	resolve: (payload: Record<string, unknown>) => void;
	reject: (error: AgentRequestError) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** One live agent WebSocket. Requests are matched to answers by id, so several can be in flight. */
export class AgentConnection {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestID = randomInt(0, 0x7fffffff);
	private closed = false;

	hello: AgentProtocol.Hello | null = null;
	readonly connectedAt = Date.now();
	lastMessageAt = Date.now();

	constructor(
		readonly agentID: number,
		readonly ownerID: number,
		readonly kind: AgentSettings.Kind,
		private readonly peer: Peer,
	) {}

	get peerID() {
		return this.peer.id;
	}

	get isClosed() {
		return this.closed;
	}

	hasCapability(capability: AgentProtocol.Capability) {
		return this.hello?.capabilities.includes(capability) ?? false;
	}

	request<C extends AgentProtocol.Command>(
		cmd: C,
		payload: AgentProtocol.Commands[C]["req"],
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<AgentProtocol.Commands[C]["res"]> {
		if (this.closed) {
			return Promise.reject(new AgentRequestError("offline", "Agent is offline"));
		}

		const capability = AgentProtocol.requiredCapability(cmd, payload);
		const needsTcp =
			cmd === "STATUS" && (payload as AgentProtocol.Commands["STATUS"]["req"]).tcp_port;
		if (
			(capability && !this.hasCapability(capability)) ||
			(needsTcp && !this.hasCapability("status.tcp"))
		) {
			return Promise.reject(
				new AgentRequestError("unsupported", `Agent doesn't support ${capability ?? "status.tcp"}`),
			);
		}

		const id = this.nextRequestID;
		this.nextRequestID = (this.nextRequestID + 1) % 0x100000000;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new AgentRequestError("timeout", "Agent didn't answer in time"));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: resolve as PendingRequest["resolve"],
				reject,
				timer,
			});

			this.send({ t: "req", id, cmd, p: payload as Record<string, unknown> });
		});
	}

	/**
	 * Handles a text frame from the agent. Answers resolve their request; events are returned to
	 * the caller. Invalid frames are logged and dropped.
	 */
	handleText(text: string): Extract<AgentProtocol.Frame, { t: "evt" }> | null {
		this.lastMessageAt = Date.now();

		if (text.length > AgentProtocol.MAX_FRAME_BYTES) {
			Logger.warn(
				`Agent ${this.agentID}: dropped a frame larger than ${AgentProtocol.MAX_FRAME_BYTES} bytes`,
			);
			return null;
		}

		let frame: AgentProtocol.Frame;
		try {
			const parsed = AgentProtocol.Frame.safeParse(JSON.parse(text));
			if (!parsed.success) {
				Logger.warn(`Agent ${this.agentID}: dropped an invalid frame`);
				return null;
			}
			frame = parsed.data;
		} catch {
			Logger.warn(`Agent ${this.agentID}: dropped a frame that isn't JSON`);
			return null;
		}

		if (frame.t === "evt") return frame;

		if (frame.t === "res") {
			const pending = this.pending.get(frame.id);
			if (!pending) return null;

			this.pending.delete(frame.id);
			clearTimeout(pending.timer);

			if (frame.ok) {
				pending.resolve(frame.p ?? {});
			} else {
				pending.reject(new AgentRequestError("rejected", frame.err || "Agent rejected the request"));
			}
			return null;
		}

		// Agents don't send requests in protocol v2.
		this.send({ t: "res", id: frame.id, ok: false, err: `Unknown command ${frame.cmd}` });
		return null;
	}

	/** Marks the connection closed and fails every pending request. */
	detach() {
		if (this.closed) return;
		this.closed = true;

		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new AgentRequestError("offline", "Agent disconnected"));
			this.pending.delete(id);
		}
	}

	close(code: number, reason: string) {
		this.detach();
		try {
			this.peer.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	private send(frame: AgentProtocol.Frame) {
		try {
			this.peer.send(JSON.stringify(frame));
		} catch (error) {
			Logger.warn(`Agent ${this.agentID}: send failed`, error);
		}
	}
}
