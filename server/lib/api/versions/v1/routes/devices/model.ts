import { isIP } from "node:net";
import { z } from "zod";
import {
	AgentSettings,
	DeviceSettings,
	ShareSettings,
} from "../../../../utils/shared-models/netigniteData";

const HOSTNAME =
	/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/** Checks `status_address` against `status_method`; used by create and update. */
export function validateStatusConfig(
	method: DeviceSettings.StatusMethod,
	address: string | null | undefined,
): string | null {
	switch (method) {
		case "ipv4":
			return address && isIP(address) === 4
				? null
				: "An IPv4 address is required for the IPv4 status check";
		case "ipv6": {
			// Allow a zone suffix (`fe80::1%eth0`); the agent uses its own interface.
			const bare = address?.split("%")[0];
			return bare && isIP(bare) === 6 ? null : "An IPv6 address is required for the IPv6 status check";
		}
		case "ssh":
			return address && (isIP(address) !== 0 || HOSTNAME.test(address))
				? null
				: "An IP address or host name is required for the SSH status check";
		default:
			return null;
	}
}

const AgentSummary = z.object({
	id: z.number(),
	name: z.string(),
	kind: AgentSettings.Kind,
	state: AgentSettings.ConnectionState,
});

export namespace DevicesModel {
	export const AccessRole = z.enum(["owner", ...ShareSettings.Roles]);

	export const Status = z.object({
		state: DeviceSettings.OnlineState,
		checked_at: z.number().nullable(),
		reason: z.string().optional(),
	});

	export const Device = z.object({
		id: z.number(),
		name: z.string(),
		type: DeviceSettings.Type,
		description: z.string(),
		mac_address: z.string(),
		wol_port: z.number(),
		agent_id: z.number().nullable(),
		status_method: DeviceSettings.StatusMethod,
		status_address: z.string().nullable(),
		status_tcp_port: z.number().nullable(),
		host_agent_id: z.number().nullable(),
		created_at: z.number(),

		/** The caller's role on this device. */
		access_role: AccessRole,
		owner: z.object({ id: z.number(), username: z.string(), display_name: z.string() }),
		/** The agents' names and states, also readable by users the device is shared with. */
		agent: AgentSummary.nullable(),
		host_agent: AgentSummary.nullable(),
		favorite: z.boolean(),
		status: Status,
		actions: z.object({ power_on: z.boolean(), shutdown: z.boolean(), reboot: z.boolean() }),
	});
	export type Device = z.infer<typeof Device>;

	const Fields = {
		name: z.string().trim().min(1, "Name is required").max(64, "Name is too long"),
		type: DeviceSettings.Type,
		description: z.string().trim().max(500, "Description is too long"),
		mac_address: DeviceSettings.MacAddress,
		wol_port: DeviceSettings.WolPort,
		agent_id: z.number().int().positive().nullable(),
		status_method: DeviceSettings.StatusMethod,
		status_address: z.string().trim().min(1).max(253).nullable(),
		status_tcp_port: z.number().int().min(1).max(65535).nullable(),
		host_agent_id: z.number().int().positive().nullable(),
	};

	export namespace Create {
		export const Body = z.object({
			name: Fields.name,
			type: Fields.type,
			description: Fields.description.default(""),
			mac_address: Fields.mac_address,
			wol_port: Fields.wol_port.default(9),
			agent_id: Fields.agent_id.default(null),
			status_method: Fields.status_method.default("none"),
			status_address: Fields.status_address.default(null),
			status_tcp_port: Fields.status_tcp_port.default(null),
			host_agent_id: Fields.host_agent_id.default(null),
		});
		export type Body = z.infer<typeof Body>;
	}

	/** All fields optional. `agent_id` and `host_agent_id` can only be changed by the owner. */
	export namespace Update {
		export const Body = z.object(Fields).partial();
		export type Body = z.infer<typeof Body>;
	}

	export namespace Share {
		export const Share = z.object({
			user: z.object({ id: z.number(), username: z.string(), display_name: z.string() }),
			role: ShareSettings.Role,
			created_at: z.number(),
		});
		export type Share = z.infer<typeof Share>;

		export const CreateBody = z.object({
			/** Username or email address of the user to share with. */
			user: z.string().trim().min(1).max(255),
			role: ShareSettings.Role,
		});

		export const UpdateBody = z.object({ role: ShareSettings.Role });
	}
}

export namespace DevicesModel.Ssh {
	const Host = z
		.string()
		.trim()
		.max(253)
		.refine(
			(host) => isIP(host.split("%")[0] ?? "") !== 0 || HOSTNAME.test(host),
			"Enter an IP address or host name",
		);

	export const Body = z.object({
		/** Host name or IP; null uses the device's status address. */
		host: Host.nullable().default(null),
		port: z.number().int().min(1).max(65535).default(22),
		username: z
			.string()
			.trim()
			.min(1, "Username is required")
			.max(64)
			.regex(/^[A-Za-z0-9._@\\-]+$/, "Invalid username"),
		/** `posix`: `shutdown -h now` (Linux, macOS, BSD); `windows`: `shutdown /s /t 0`. */
		os: DeviceSettings.SshOperatingSystem.default("posix"),
		/** POSIX: run the command with `sudo -n` (not for root). */
		sudo: z.boolean().default(true),
		/** A password, a new Ed25519 key generated by the server, or the stored secret. */
		auth: z.discriminatedUnion("type", [
			z.object({ type: z.literal("password"), password: z.string().min(1).max(256) }),
			z.object({ type: z.literal("generate_key") }),
			z.object({ type: z.literal("keep") }),
		]),
	});
	export type Body = z.infer<typeof Body>;

	/** The login without its secret. */
	export const Response = z.object({
		configured: z.boolean(),
		host: z.string().nullable(),
		/** The host the agent connects to (the login's, or the device's status address). */
		effective_host: z.string().nullable(),
		port: z.number().nullable(),
		username: z.string().nullable(),
		auth_type: DeviceSettings.SshAuthType.nullable(),
		os: DeviceSettings.SshOperatingSystem.nullable(),
		sudo: z.boolean().nullable(),
		/** For a generated key: the public key. */
		public_key: z.string().nullable(),
		/** The trusted host key fingerprint; shutdown and reboot need one. */
		host_key: z.string().nullable(),
		/** Line for `~/.ssh/authorized_keys` on the device (generated keys). */
		authorized_keys: z.string().nullable(),
		/** Line for `/etc/sudoers.d/netignite` on the device (POSIX with sudo). */
		sudoers: z.string().nullable(),
		/** Whether the device's agent is online and can log in over SSH. */
		agent_ready: z.boolean(),
	});
	export type Response = z.infer<typeof Response>;

	export const TestResponse = z.object({
		online: z.boolean(),
		authenticated: z.boolean(),
		/** The fingerprint the device presented. */
		host_key: z.string().nullable(),
		/** Whether it is the trusted one. */
		trusted: z.boolean(),
		error: z.string().nullable(),
	});
	export type TestResponse = z.infer<typeof TestResponse>;

	export const TrustBody = z.object({
		host_key: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Invalid fingerprint"),
	});
}
