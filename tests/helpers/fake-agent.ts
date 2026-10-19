import { randomUUID } from "node:crypto";
import { AgentGatewayRunner } from "../../server/lib/agents/gateway";
import { makeAPIRequest } from "./api";

type Frame = {
	t: string;
	id?: number;
	cmd?: string;
	p?: Record<string, unknown>;
	ok?: boolean;
	err?: string;
};
type Handler = (cmd: string, payload: Record<string, any>) => unknown | Promise<unknown>;

/**
 * An agent driven through the real gateway hooks (upgrade → open → message → close), without a
 * network. `handler` answers the server's requests; throwing makes the agent answer `ok: false`.
 */
export class FakeAgent {
	readonly id = randomUUID();
	readonly context: Record<string, unknown> = {};
	readonly requests: Frame[] = [];
	closed: { code?: number; reason?: string } | null = null;

	private readonly hooks = AgentGatewayRunner.hooks();

	constructor(private handler: Handler = () => ({})) {}

	/** Enrolls with a fresh enrollment token of `agentID` and returns the agent credential. */
	static async enroll(agentID: number, ownerToken: string) {
		const enrollment = await makeAPIRequest<{ token: string }>(`/v1/agents/${agentID}/enrollments`, {
			method: "POST",
			authToken: ownerToken,
		});
		const secret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
		const enrolled = await makeAPIRequest<{ token_id: string }>("/v1/agents/enroll", {
			method: "POST",
			body: { enrollment_token: enrollment.token, secret },
		});
		return `netignite_agent_${enrolled.token_id}:${secret}`;
	}

	/** Runs the upgrade hook; returns the rejection Response, or null if the upgrade was accepted. */
	async upgrade(credential: string | null) {
		const headers = new Headers(credential ? { Authorization: `Bearer ${credential}` } : {});
		const result = await this.hooks.upgrade!({
			url: "http://localhost/ws/agent",
			headers,
			context: this.context,
		} as any);
		return result instanceof Response ? result : null;
	}

	async connect(credential: string, hello: Record<string, unknown> | null = {}) {
		const rejected = await this.upgrade(credential);
		if (rejected) throw new Error(`Upgrade rejected with ${rejected.status}`);

		await this.hooks.open!(this as any);
		if (hello) {
			await this.event("HELLO", {
				protocol: 2,
				kind: "esp32",
				version: "2.0.0-test",
				capabilities: ["wake", "status.link_local", "status.ip", "status.host", "status.tcp"],
				...hello,
			});
		}
	}

	async event(cmd: string, payload: Record<string, unknown>) {
		await this.receive({ t: "evt", cmd, p: payload });
	}

	async disconnect() {
		await this.hooks.close!(this as any, { code: 1000, reason: "test" });
	}

	setHandler(handler: Handler) {
		this.handler = handler;
	}

	// --- Peer interface used by the gateway ---

	send(data: string) {
		const frame = JSON.parse(data) as Frame;
		if (frame.t !== "req") return;
		this.requests.push(frame);

		void (async () => {
			try {
				const result = await this.handler(frame.cmd as string, frame.p ?? {});
				if (result === undefined) return; // never answer: simulates a hung agent
				await this.receive({ t: "res", id: frame.id, ok: true, p: result as Record<string, unknown> });
			} catch (error) {
				await this.receive({
					t: "res",
					id: frame.id,
					ok: false,
					err: String((error as Error).message),
				});
			}
		})();
	}

	close(code?: number, reason?: string) {
		this.closed = { code, reason };
	}

	private async receive(frame: Frame) {
		await this.hooks.message!(this as any, { text: () => JSON.stringify(frame) } as any);
	}
}
