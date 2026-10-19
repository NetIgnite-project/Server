import { z } from "zod";
import { AgentSettings } from "../api/utils/shared-models/netigniteData";

/**
 * NetIgnite agent protocol, version 2.
 *
 * Agents keep one WebSocket to `/ws/agent` open (`Authorization: Bearer netignite_agent_<id>:<secret>`).
 * Every message is a JSON text frame:
 *
 * - `{ "t": "req", "id": <u32>, "cmd": "WAKE", "p": { ... } }`: a request (server → agent)
 * - `{ "t": "res", "id": <u32>, "ok": true, "p": { ... } }`: the answer, same `id`
 * - `{ "t": "res", "id": <u32>, "ok": false, "err": "..." }`: a failed request
 * - `{ "t": "evt", "cmd": "HELLO", "p": { ... } }`: an event without an answer (agent → server)
 *
 * The first frame an agent sends is the `HELLO` event. The server only sends commands whose
 * capability the agent listed there.
 */
export namespace AgentProtocol {
	export const VERSION = 2;

	/** Largest frame the server accepts from an agent. */
	export const MAX_FRAME_BYTES = 64 * 1024;

	export const Capabilities = [
		// WAKE
		"wake",
		// STATUS targets and probes
		"status.link_local",
		"status.ip",
		"status.host",
		"status.tcp",
		// The agent runs on the device itself (Linux agent): HOST_STATUS events, HOST_CONTROL
		"host.status",
		"host.control",
	] as const;
	export type Capability = (typeof Capabilities)[number];

	const U32 = z.number().int().min(0).max(0xffffffff);
	const Payload = z.record(z.string(), z.unknown());

	export const Frame = z.discriminatedUnion("t", [
		z.object({
			t: z.literal("req"),
			id: U32,
			cmd: z.string().min(1).max(64),
			p: Payload.default({}),
		}),
		z.object({
			t: z.literal("res"),
			id: U32,
			ok: z.boolean(),
			p: Payload.optional(),
			err: z.string().max(1024).optional(),
		}),
		z.object({ t: z.literal("evt"), cmd: z.string().min(1).max(64), p: Payload.default({}) }),
	]);
	export type Frame = z.infer<typeof Frame>;

	export const Hello = z.object({
		protocol: z.literal(VERSION),
		kind: AgentSettings.Kind,
		version: z.string().min(1).max(64),
		// Unknown capabilities are kept, so newer agents can talk to an older server.
		capabilities: z.array(z.string().max(64)).max(64),
		// Free-form diagnostics shown in the dashboard (IP addresses, RSSI, reset reason, ...).
		info: z.record(z.string(), z.unknown()).optional(),
	});
	export type Hello = z.infer<typeof Hello>;

	export const HostStatus = z.object({
		hostname: z.string().max(255).optional(),
		uptime_s: z.number().nonnegative().optional(),
	});
	export type HostStatus = z.infer<typeof HostStatus>;

	export type StatusTarget =
		| { type: "link_local"; mac: string }
		| { type: "ip"; address: string }
		| { type: "host"; host: string };

	/** Requests the server sends, with the payload the agent answers with. */
	export interface Commands {
		/** Keep-alive. */
		PING: { req: Record<string, never>; res: Record<string, never> };
		/** Send a Wake-on-LAN magic packet. */
		WAKE: { req: { mac: string; port: number }; res: Record<string, never> };
		/** Check whether a device answers. Online if any requested probe answers. */
		STATUS: {
			req: { target: StatusTarget; icmp: boolean; tcp_port?: number };
			res: { online: boolean };
		};
		/** Shut down or reboot the machine the agent runs on. */
		HOST_CONTROL: { req: { action: "shutdown" | "reboot" }; res: Record<string, never> };
	}
	export type Command = keyof Commands;

	/** Capability an agent must have advertised before the server sends a command. */
	export function requiredCapability(
		command: Command,
		payload: Commands[Command]["req"],
	): Capability | null {
		switch (command) {
			case "PING":
				return null;
			case "WAKE":
				return "wake";
			case "HOST_CONTROL":
				return "host.control";
			case "STATUS": {
				const { target } = payload as Commands["STATUS"]["req"];
				if (target.type === "link_local") return "status.link_local";
				if (target.type === "ip") return "status.ip";
				return "status.host";
			}
		}
	}
}
