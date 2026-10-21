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
		// ESP32: OTA_BEGIN + OTA_PROGRESS events
		"ota",
		// GET_LOGS, LOG_SUBSCRIBE + LOG events
		"logs",
		// GET_INFO, CONFIG_SET
		"config",
		// REBOOT, FACTORY_RESET
		"device.reboot",
		"device.reset",
		// SSH_CHECK, SSH_EXEC (logs into devices in the agent's network)
		"ssh",
	] as const;
	export type Capability = (typeof Capabilities)[number];

	/** `LOG` event: new log lines while subscribed. */
	export const LogEvent = z.object({
		lines: z.array(z.string().max(1024)).max(500),
		/** Lines the agent dropped because its buffer was full. */
		dropped: z.number().int().nonnegative().optional(),
	});
	export type LogEvent = z.infer<typeof LogEvent>;

	/** `OTA_PROGRESS` event during an update. */
	export const OtaProgressEvent = z.object({
		version: z.string().max(64),
		state: z.enum(["downloading", "installed", "failed"]),
		percent: z.number().int().min(0).max(100),
		error: z.string().max(256).optional(),
	});
	export type OtaProgressEvent = z.infer<typeof OtaProgressEvent>;

	export type LogLevel = "error" | "warn" | "info" | "debug";

	/**
	 * An SSH login for SSH_CHECK / SSH_EXEC. `host_key`: the trusted fingerprint (`SHA256:…`); the
	 * agent aborts before sending credentials if the server's key differs.
	 */
	export type SshTarget = {
		host: string;
		port: number;
		username: string;
		auth: { type: "password"; password: string } | { type: "key"; private_key: string };
		host_key: string | null;
	};

	export type SshCheckResult = {
		/** Whether the SSH port accepted the connection. */
		online: boolean;
		host_key?: string;
		authenticated?: boolean;
		/** `host_key_mismatch`, `auth_failed` or a short message. */
		error?: string;
	};

	/** CONFIG_SET: only the fields present change. Server URL and IP changes are tried first. */
	export type ConfigSet = {
		server_url?: string;
		name?: string;
		log_level?: LogLevel;
		ip?:
			| { mode: "dhcp" }
			| {
					mode: "static";
					address: string;
					gateway: string;
					netmask: string;
					dns1?: string;
					dns2?: string;
			  };
	};

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
		/**
		 * Download `path` from this server (with the agent credential) and install it. The answer
		 * only means the download started; OTA_PROGRESS events follow, then a HELLO with the new
		 * version.
		 */
		OTA_BEGIN: {
			req: { version: string; path: string; size: number; sha256: string; signature?: string };
			res: Record<string, never>;
		};
		/** The stored log lines. */
		GET_LOGS: { req: Record<string, never>; res: { lines?: string[]; level?: LogLevel } };
		/** With `enabled`, the stored lines; LOG events with new lines follow until disabled. */
		LOG_SUBSCRIBE: {
			req: { enabled: boolean };
			res: { lines?: string[]; level?: LogLevel };
		};
		/** Current diagnostics (the same as HELLO's `info`). */
		GET_INFO: {
			req: Record<string, never>;
			res: { version?: string; info?: Record<string, unknown> };
		};
		CONFIG_SET: { req: ConfigSet; res: Record<string, never> };
		/** Restart the agent. */
		REBOOT: { req: Record<string, never>; res: Record<string, never> };
		/** Erase Wi-Fi, server and credential, then restart. The agent has to be set up again. */
		FACTORY_RESET: { req: Record<string, never>; res: Record<string, never> };
		/** Log in over SSH without opening a session (forced commands never run). */
		SSH_CHECK: { req: SshTarget; res: SshCheckResult };
		/**
		 * Log in (only with a trusted host key) and run the fixed shutdown or reboot command for the
		 * OS: `[sudo -n ]shutdown -h|-r now`, or `shutdown /s|/r /t 0`.
		 */
		SSH_EXEC: {
			req: SshTarget & {
				host_key: string;
				action: "shutdown" | "reboot";
				os: "posix" | "windows";
				sudo: boolean;
			};
			res: Record<string, never>;
		};
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
			case "OTA_BEGIN":
				return "ota";
			case "GET_LOGS":
			case "LOG_SUBSCRIBE":
				return "logs";
			case "GET_INFO":
			case "CONFIG_SET":
				return "config";
			case "REBOOT":
				return "device.reboot";
			case "FACTORY_RESET":
				return "device.reset";
			case "SSH_CHECK":
			case "SSH_EXEC":
				return "ssh";
			case "STATUS": {
				const { target } = payload as Commands["STATUS"]["req"];
				if (target.type === "link_local") return "status.link_local";
				if (target.type === "ip") return "status.ip";
				return "status.host";
			}
		}
	}
}
