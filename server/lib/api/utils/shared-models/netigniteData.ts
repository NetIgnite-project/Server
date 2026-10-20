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

export namespace FirmwareSettings {
	/** `stable`: releases only. `prerelease`: also betas and release candidates. */
	export const Channels = ["stable", "prerelease"] as const;
	export const Channel = z.enum(Channels);
	export type Channel = z.infer<typeof Channel>;

	/** `2.0.0`, `2.1.0-beta.1`: a release tag without its `v`. */
	export const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, "Invalid version");

	const FileName = z.string().regex(/^[A-Za-z0-9_.-]+$/, "Invalid file name");

	/**
	 * `release.json` of an Agent-ESP32 release (scripts/collect_release.py): the flash images with
	 * their offsets, and where the installer writes the agent's provisioning data.
	 */
	export const Manifest = z.object({
		format: z.literal(1),
		name: z.string(),
		version: Version,
		chip_family: z.literal("ESP32"),
		board: z.string(),
		protocol: z.number().int(),
		parts: z
			.array(
				z.object({
					file: FileName,
					offset: z.number().int().nonnegative(),
					size: z.number().int().positive(),
					sha256: z.string().regex(/^[0-9a-f]{64}$/),
				}),
			)
			.min(1),
		nvs: z.object({
			offset: z.number().int().nonnegative(),
			size: z.number().int().positive(),
			namespace: z.string().min(1).max(15),
			keys: z.array(z.string()),
		}),
		app: z.object({
			file: FileName,
			signature: FileName.nullable(),
		}),
	});
	export type Manifest = z.infer<typeof Manifest>;
}
