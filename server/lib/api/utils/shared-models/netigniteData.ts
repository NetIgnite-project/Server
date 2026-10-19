import { z } from "zod";

export namespace AgentSettings {
	/** `esp32`: the ESP32 firmware. `linux`: the Linux agent (systemd service). */
	export const Kinds = ["esp32", "linux"] as const;
	export const Kind = z.enum(Kinds);
	export type Kind = z.infer<typeof Kind>;

	/** Connection state of an agent, as shown in the dashboard. */
	export const ConnectionStates = ["online", "offline", "unenrolled"] as const;
	export const ConnectionState = z.enum(ConnectionStates);
	export type ConnectionState = z.infer<typeof ConnectionState>;
}

export namespace DeviceSettings {
	export const Types = ["server", "desktop", "laptop", "printer", "nas", "other"] as const;
	export const Type = z.enum(Types);
	export type Type = z.infer<typeof Type>;

	/**
	 * How a device's online status is determined.
	 * - `none`: never checked
	 * - `link_local`: the agent pings the IPv6 link-local address derived from the MAC (EUI-64)
	 * - `ipv4` / `ipv6`: the agent checks the configured `status_address`
	 * - `ssh`: the agent probes the SSH port of `status_address`
	 * - `host_agent`: a Linux agent running on the device reports it
	 */
	export const StatusMethods = ["none", "link_local", "ipv4", "ipv6", "ssh", "host_agent"] as const;
	export const StatusMethod = z.enum(StatusMethods);
	export type StatusMethod = z.infer<typeof StatusMethod>;

	export const OnlineStates = ["online", "offline", "unknown"] as const;
	export const OnlineState = z.enum(OnlineStates);
	export type OnlineState = z.infer<typeof OnlineState>;

	/** Six hex pairs separated by `:` or `-` (the format the agents accept). */
	export const MacAddress = z
		.string()
		.regex(/^[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$/, "Invalid MAC address")
		.transform((mac) => mac.toUpperCase().replaceAll("-", ":"));

	export const WolPort = z.number().int().min(1).max(65535);
}

export namespace ShareSettings {
	/**
	 * - `viewer`: sees the device and its status
	 * - `operator`: + power on, shutdown, reboot
	 * - `manager`: + edits the device's settings
	 */
	export const Roles = ["viewer", "operator", "manager"] as const;
	export const Role = z.enum(Roles);
	export type Role = z.infer<typeof Role>;
}
