import { and, eq, inArray, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import z from "zod";
import { AgentRequestError } from "../../../../../agents/connection";
import { DB } from "../../../../../db";
import { DeviceActionError, DeviceActions } from "../../../../../devices/actions";
import { DevicePermissions } from "../../../../../devices/permissions";
import { DeviceStatusService } from "../../../../../devices/status";
import { SshLogins } from "../../../../../ssh/logins";
import { APIResponse } from "../../../../utils/api-res";
import { AgentSettings } from "../../../../utils/shared-models/netigniteData";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { getUserID, requireUser } from "../../middleware/requireUser";
import { toAgentResponse } from "../agents";
import { DevicesModel, validateStatusConfig } from "./model";

export const router = new Hono().basePath("/devices");

router.use("*", requireUser);

type UserSummary = { id: number; username: string; display_name: string };

async function getUsers(ids: number[]) {
	if (ids.length === 0) return new Map<number, UserSummary>();

	const users = await DB.instance()
		.select({
			id: DB.Tables.users.id,
			username: DB.Tables.users.username,
			display_name: DB.Tables.users.display_name,
		})
		.from(DB.Tables.users)
		.where(inArray(DB.Tables.users.id, [...new Set(ids)]));
	return new Map(users.map((user) => [user.id, user]));
}

async function getAgentSummaries(ids: (number | null)[]) {
	const agentIDs = [...new Set(ids.filter((id): id is number => id !== null))];
	if (agentIDs.length === 0) return new Map<number, NonNullable<DevicesModel.Device["agent"]>>();

	const agents = await DB.instance()
		.select()
		.from(DB.Tables.agents)
		.where(inArray(DB.Tables.agents.id, agentIDs));
	return new Map(
		agents.map((agent) => {
			const { id, name, kind, state } = toAgentResponse(agent);
			return [agent.id, { id, name, kind, state }];
		}),
	);
}

async function toDeviceResponses(userID: number, devices: DevicePermissions.DeviceWithRole[]) {
	const owners = await getUsers(devices.map((device) => device.owner_id));
	const agents = await getAgentSummaries(
		devices.flatMap((device) => [device.agent_id, device.host_agent_id]),
	);
	const sshTrusted = (await SshLogins.enabled())
		? SshLogins.trustedDeviceIDs(devices.map((device) => device.id))
		: new Set<number>();
	const favorites = new Set(
		(
			await DB.instance()
				.select({ device_id: DB.Tables.deviceFavorites.device_id })
				.from(DB.Tables.deviceFavorites)
				.where(eq(DB.Tables.deviceFavorites.user_id, userID))
		).map((favorite) => favorite.device_id),
	);

	return devices.map(
		(device): DevicesModel.Device => ({
			id: device.id,
			name: device.name,
			type: device.type,
			description: device.description,
			mac_address: device.mac_address,
			wol_port: device.wol_port,
			agent_id: device.agent_id,
			status_method: device.status_method,
			status_address: device.status_address,
			status_tcp_port: device.status_tcp_port,
			host_agent_id: device.host_agent_id,
			created_at: device.created_at,
			access_role: device.access_role,
			owner: owners.get(device.owner_id) ?? {
				id: device.owner_id,
				username: "unknown",
				display_name: "Unknown",
			},
			agent: device.agent_id !== null ? (agents.get(device.agent_id) ?? null) : null,
			host_agent: device.host_agent_id !== null ? (agents.get(device.host_agent_id) ?? null) : null,
			favorite: favorites.has(device.id),
			status: DeviceStatusService.get(device.id),
			actions: DevicePermissions.can(device.access_role, "power")
				? DeviceActions.availableActions(device, sshTrusted.has(device.id))
				: { power_on: false, shutdown: false, reboot: false },
		}),
	);
}

/** Agents referenced by a device must belong to the device's owner. */
async function checkAgentOwnership(ownerID: number, agentIDs: (number | null | undefined)[]) {
	const ids = agentIDs.filter((id): id is number => typeof id === "number");
	if (ids.length === 0) return true;

	const agents = await DB.instance()
		.select({ id: DB.Tables.agents.id })
		.from(DB.Tables.agents)
		.where(and(inArray(DB.Tables.agents.id, ids), eq(DB.Tables.agents.owner_id, ownerID)));
	return agents.length === new Set(ids).size;
}

async function checkHostAgentKind(hostAgentID: number | null | undefined) {
	if (typeof hostAgentID !== "number") return true;
	const agent = await DB.instance()
		.select({ kind: DB.Tables.agents.kind })
		.from(DB.Tables.agents)
		.where(eq(DB.Tables.agents.id, hostAgentID))
		.get();
	return agent ? AgentSettings.isComputer(agent.kind) : false;
}

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List devices",
		description: "Devices the user owns and devices shared with them, with the user's role on each.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Devices retrieved", DevicesModel.Device.array()),
		),
	}),

	async (c) => {
		const userID = getUserID(c);
		const devices = await DevicePermissions.listAccessible(userID);
		return APIResponse.success(c, "Devices retrieved", await toDeviceResponses(userID, devices));
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create a device",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.created("Device created", DevicesModel.Device),
		),
	}),

	validator("json", DevicesModel.Create.Body),

	async (c) => {
		const userID = getUserID(c);
		const body = c.req.valid("json");

		const statusError = validateStatusConfig(body.status_method, body.status_address);
		if (statusError) return APIResponse.badRequest(c, statusError);

		if (!(await checkAgentOwnership(userID, [body.agent_id, body.host_agent_id]))) {
			return APIResponse.badRequest(c, "Unknown agent");
		}
		if (!(await checkHostAgentKind(body.host_agent_id))) {
			return APIResponse.badRequest(
				c,
				"The agent on the device must be a Linux, Windows or macOS agent",
			);
		}

		const device = await DB.instance()
			.insert(DB.Tables.devices)
			.values({ ...body, owner_id: userID })
			.returning()
			.get();

		void DeviceStatusService.refresh(device);

		const [response] = await toDeviceResponses(userID, [{ ...device, access_role: "owner" }]);
		return APIResponse.created(c, "Device created", response as DevicesModel.Device);
	},
);

// --- Single device ---------------------------------------------------------------------------

const DeviceParam = z.object({ deviceID: z.coerce.number().int().positive() });

/** Resolves `:deviceID` to a device the caller can access, or answers 404. */
router.use("/:deviceID/*", validator("param", DeviceParam), async (c, next) => {
	// @ts-ignore set by the validator above
	const { deviceID } = c.req.valid("param") as z.infer<typeof DeviceParam>;

	const device = await DevicePermissions.getAccess(getUserID(c), deviceID);
	if (!device) return APIResponse.notFound(c, "Device not found");

	// @ts-ignore
	c.set("device", device);
	await next();
});

function getDevice(c: Context) {
	// @ts-ignore set by the middleware above
	return c.get("device") as DevicePermissions.DeviceWithRole;
}

function forbidden(c: Context, action: DevicePermissions.Action) {
	const messages: Record<DevicePermissions.Action, string> = {
		read: "You can't access this device",
		power: "Your role on this device doesn't allow power actions",
		edit: "Your role on this device doesn't allow editing it",
		manage: "Only the device's owner can do this",
	};
	return APIResponse.forbidden(c, messages[action]);
}

async function deviceResponse(c: Context, device: DevicePermissions.DeviceWithRole) {
	const [response] = await toDeviceResponses(getUserID(c), [device]);
	return response as DevicesModel.Device;
}

router.get(
	"/:deviceID",

	APIRouteSpec.authenticated({
		summary: "Get a device",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Device retrieved", DevicesModel.Device),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => APIResponse.success(c, "Device retrieved", await deviceResponse(c, getDevice(c))),
);

router.put(
	"/:deviceID",

	APIRouteSpec.authenticated({
		summary: "Update a device",
		description: "Owners and managers can edit a device; only the owner can change its agents.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Device updated", DevicesModel.Device),
			APIResponseSpec.forbidden("Your role doesn't allow this change"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	validator("json", DevicesModel.Update.Body),

	async (c) => {
		const device = getDevice(c);
		const body = c.req.valid("json");

		if (!DevicePermissions.can(device.access_role, "edit")) return forbidden(c, "edit");

		const changesAgents =
			(body.agent_id !== undefined && body.agent_id !== device.agent_id) ||
			(body.host_agent_id !== undefined && body.host_agent_id !== device.host_agent_id);
		if (changesAgents && !DevicePermissions.can(device.access_role, "manage"))
			return forbidden(c, "manage");

		const merged = { ...device, ...body };
		const statusError = validateStatusConfig(merged.status_method, merged.status_address);
		if (statusError) return APIResponse.badRequest(c, statusError);

		if (!(await checkAgentOwnership(device.owner_id, [body.agent_id, body.host_agent_id]))) {
			return APIResponse.badRequest(c, "Unknown agent");
		}
		if (!(await checkHostAgentKind(body.host_agent_id))) {
			return APIResponse.badRequest(
				c,
				"The agent on the device must be a Linux, Windows or macOS agent",
			);
		}

		const updated = await DB.instance()
			.update(DB.Tables.devices)
			.set(body)
			.where(eq(DB.Tables.devices.id, device.id))
			.returning()
			.get();

		DeviceStatusService.forget(device.id);
		void DeviceStatusService.refresh(updated);

		return APIResponse.success(
			c,
			"Device updated",
			await deviceResponse(c, { ...updated, access_role: device.access_role }),
		);
	},
);

router.delete(
	"/:deviceID",

	APIRouteSpec.authenticated({
		summary: "Delete a device",
		description: "Only the owner can delete a device. Its shares are removed as well.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Device deleted"),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");

		await DB.instance().delete(DB.Tables.devices).where(eq(DB.Tables.devices.id, device.id));
		DeviceStatusService.forget(device.id);

		return APIResponse.successNoData(c, "Device deleted");
	},
);

// --- Power and status ------------------------------------------------------------------------

function powerRoute(
	path: string,
	summary: string,
	description: string,
	run: (device: DB.Models.Device) => Promise<void>,
	successMessage: string,
) {
	router.post(
		`/:deviceID/${path}`,

		APIRouteSpec.authenticated({
			summary,
			description,
			tags: [DOCS_TAGS.DEVICES],
			responses: APIResponseSpec.describeBasic(
				APIResponseSpec.successNoData(successMessage),
				APIResponseSpec.forbidden("Your role on this device doesn't allow power actions"),
				APIResponseSpec.notFound("Device not found"),
				APIResponseSpec.conflict("The device has no method for this action"),
				APIResponseSpec.badGateway("The agent reported an error"),
				APIResponseSpec.serviceUnavailable("The agent is offline"),
				APIResponseSpec.gatewayTimeout("The agent didn't answer in time"),
			),
		}),

		async (c) => {
			const device = getDevice(c);
			if (!DevicePermissions.can(device.access_role, "power")) return forbidden(c, "power");

			try {
				await run(device);
			} catch (error) {
				if (!(error instanceof DeviceActionError)) throw error;
				switch (error.status) {
					case 409:
						return APIResponse.conflict(c, error.message);
					case 502:
						return APIResponse.badGateway(c, error.message);
					case 503:
						return APIResponse.serviceUnavailable(c, error.message);
					case 504:
						return APIResponse.gatewayTimeout(c, error.message);
				}
			}

			return APIResponse.successNoData(c, successMessage);
		},
	);
}

powerRoute(
	"power-on",
	"Power on a device",
	"Sends a Wake-on-LAN packet through the device's agent. Success means the packet was sent.",
	(device) => DeviceActions.powerOn(device),
	"Wake-on-LAN packet sent",
);
powerRoute(
	"shutdown",
	"Shut down a device",
	"Shuts the device down through the Linux agent running on it, or over SSH through its agent.",
	(device) => DeviceActions.hostControl(device, "shutdown"),
	"Shutdown requested",
);
powerRoute(
	"reboot",
	"Reboot a device",
	"Reboots the device through the Linux agent running on it, or over SSH through its agent.",
	(device) => DeviceActions.hostControl(device, "reboot"),
	"Reboot requested",
);

router.post(
	"/:deviceID/status",

	APIRouteSpec.authenticated({
		summary: "Check a device's status now",
		description:
			"Runs the status check immediately (at most every 5 seconds per device) and returns the result.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Status checked", DevicesModel.Status),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) =>
		APIResponse.success(c, "Status checked", await DeviceStatusService.refresh(getDevice(c))),
);

router.put(
	"/:deviceID/favorite",

	APIRouteSpec.authenticated({
		summary: "Add a device to your favorites",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Added to favorites"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		await DB.instance()
			.insert(DB.Tables.deviceFavorites)
			.values({ user_id: getUserID(c), device_id: getDevice(c).id })
			.onConflictDoNothing();
		return APIResponse.successNoData(c, "Added to favorites");
	},
);

router.delete(
	"/:deviceID/favorite",

	APIRouteSpec.authenticated({
		summary: "Remove a device from your favorites",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Removed from favorites"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		await DB.instance()
			.delete(DB.Tables.deviceFavorites)
			.where(
				and(
					eq(DB.Tables.deviceFavorites.user_id, getUserID(c)),
					eq(DB.Tables.deviceFavorites.device_id, getDevice(c).id),
				),
			);
		return APIResponse.successNoData(c, "Removed from favorites");
	},
);

// --- Sharing ---------------------------------------------------------------------------------

async function listShares(deviceID: number): Promise<DevicesModel.Share.Share[]> {
	const shares = await DB.instance()
		.select()
		.from(DB.Tables.deviceShares)
		.where(eq(DB.Tables.deviceShares.device_id, deviceID));
	const users = await getUsers(shares.map((share) => share.user_id));

	return shares.flatMap((share) => {
		const user = users.get(share.user_id);
		return user ? [{ user, role: share.role, created_at: share.created_at }] : [];
	});
}

router.get(
	"/:deviceID/shares",

	APIRouteSpec.authenticated({
		summary: "List a device's shares",
		tags: [DOCS_TAGS.DEVICE_SHARES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Shares retrieved", DevicesModel.Share.Share.array()),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");
		return APIResponse.success(c, "Shares retrieved", await listShares(device.id));
	},
);

router.post(
	"/:deviceID/shares",

	APIRouteSpec.authenticated({
		summary: "Share a device",
		description: "Shares the device with another user, found by username or email address.",
		tags: [DOCS_TAGS.DEVICE_SHARES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.created("Device shared", DevicesModel.Share.Share),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device or user not found"),
			APIResponseSpec.conflict("The device is already shared with this user"),
		),
	}),

	validator("json", DevicesModel.Share.CreateBody),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");

		const { user: identifier, role } = c.req.valid("json");

		const user = await DB.instance()
			.select({
				id: DB.Tables.users.id,
				username: DB.Tables.users.username,
				display_name: DB.Tables.users.display_name,
			})
			.from(DB.Tables.users)
			.where(
				or(
					eq(DB.Tables.users.username, identifier),
					eq(DB.Tables.users.email, identifier),
					eq(DB.Tables.users.email, identifier.toLowerCase()),
				),
			)
			.get();

		if (!user) return APIResponse.notFound(c, "No user with this username or email address");
		if (user.id === device.owner_id)
			return APIResponse.badRequest(c, "You can't share a device with its owner");

		const share = await DB.instance()
			.insert(DB.Tables.deviceShares)
			.values({ device_id: device.id, user_id: user.id, role, created_by_user_id: getUserID(c) })
			.onConflictDoNothing()
			.returning()
			.get();

		if (!share) return APIResponse.conflict(c, "The device is already shared with this user");

		return APIResponse.created(c, "Device shared", {
			user,
			role: share.role,
			created_at: share.created_at,
		});
	},
);

const ShareParam = z.object({
	deviceID: z.coerce.number().int().positive(),
	userID: z.coerce.number().int().positive(),
});

router.put(
	"/:deviceID/shares/:userID",

	APIRouteSpec.authenticated({
		summary: "Change a share's role",
		tags: [DOCS_TAGS.DEVICE_SHARES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Share updated"),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device or share not found"),
		),
	}),

	validator("param", ShareParam),
	validator("json", DevicesModel.Share.UpdateBody),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");

		const updated = await DB.instance()
			.update(DB.Tables.deviceShares)
			.set({ role: c.req.valid("json").role })
			.where(
				and(
					eq(DB.Tables.deviceShares.device_id, device.id),
					eq(DB.Tables.deviceShares.user_id, c.req.valid("param").userID),
				),
			)
			.returning()
			.get();

		if (!updated) return APIResponse.notFound(c, "Share not found");
		return APIResponse.successNoData(c, "Share updated");
	},
);

router.delete(
	"/:deviceID/shares/:userID",

	APIRouteSpec.authenticated({
		summary: "Remove a share",
		description:
			"The owner removes a share, or a user leaves a device shared with them (their own user id).",
		tags: [DOCS_TAGS.DEVICE_SHARES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Share removed"),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device or share not found"),
		),
	}),

	validator("param", ShareParam),

	async (c) => {
		const device = getDevice(c);
		const { userID } = c.req.valid("param");

		const leaving = userID === getUserID(c);
		if (!leaving && !DevicePermissions.can(device.access_role, "manage"))
			return forbidden(c, "manage");

		const removed = await DB.instance()
			.delete(DB.Tables.deviceShares)
			.where(
				and(
					eq(DB.Tables.deviceShares.device_id, device.id),
					eq(DB.Tables.deviceShares.user_id, userID),
				),
			)
			.returning()
			.get();

		if (!removed) return APIResponse.notFound(c, "Share not found");

		// A user who loses access to a device shouldn't keep it as a favorite.
		await DB.instance()
			.delete(DB.Tables.deviceFavorites)
			.where(
				and(
					eq(DB.Tables.deviceFavorites.device_id, device.id),
					eq(DB.Tables.deviceFavorites.user_id, userID),
				),
			);

		return APIResponse.successNoData(c, "Share removed");
	},
);

// --- SSH login (owner only) ---------------------------------------------------------------------

async function toSshResponse(device: DB.Models.Device): Promise<DevicesModel.Ssh.Response> {
	const login = SshLogins.get(device.id);
	const keys = SshLogins.agentKeys(device);
	const common = {
		enabled: await SshLogins.enabled(),
		agent_keys: keys !== null,
		agent_ready: SshLogins.agentFor(device) !== null,
	};
	if (!login) {
		return {
			...common,
			configured: false,
			host: null,
			effective_host: device.status_address,
			port: null,
			username: null,
			os: null,
			sudo: null,
			host_key: null,
			authorized_keys: null,
			authorized_keys_file: null,
			sudoers: null,
		};
	}
	return {
		...common,
		configured: true,
		host: login.host,
		effective_host: SshLogins.host(device, login),
		port: login.port,
		username: login.username,
		os: login.os,
		sudo: login.sudo,
		host_key: login.host_key,
		...SshLogins.setupHints(login, device.agent_id, keys),
	};
}

const SSH_DISABLED = "SSH is turned off on this server (Server Settings)";

router.get(
	"/:deviceID/ssh",

	APIRouteSpec.authenticated({
		summary: "Get a device's SSH login",
		description: "Where the device's agent logs in, and the lines to add on the device. Owner only.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("SSH login retrieved", DevicesModel.Ssh.Response),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");
		return APIResponse.success(c, "SSH login retrieved", await toSshResponse(device));
	},
);

router.put(
	"/:deviceID/ssh",

	APIRouteSpec.authenticated({
		summary: "Set a device's SSH login",
		description:
			"Stores where the device's agent logs in for shutdown and reboot over SSH. The agent logs in " +
			"with its own keys; the answer has the authorized_keys lines for the device. Changing host " +
			"or port un-trusts the host key. Needs the server setting `ssh_enabled`.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("SSH login saved", DevicesModel.Ssh.Response),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device not found"),
			APIResponseSpec.conflict("SSH is turned off on this server"),
		),
	}),

	validator("json", DevicesModel.Ssh.Body),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");
		if (!(await SshLogins.enabled())) return APIResponse.conflict(c, SSH_DISABLED);

		const body = c.req.valid("json");
		if (!body.host && !device.status_address) {
			return APIResponse.badRequest(c, "Enter the device's host name or IP address");
		}
		SshLogins.save(device, body);
		return APIResponse.success(c, "SSH login saved", await toSshResponse(device));
	},
);

router.delete(
	"/:deviceID/ssh",

	APIRouteSpec.authenticated({
		summary: "Remove a device's SSH login",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("SSH login removed"),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device not found"),
		),
	}),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");
		SshLogins.delete(device.id);
		return APIResponse.successNoData(c, "SSH login removed");
	},
);

router.post(
	"/:deviceID/ssh/test",

	APIRouteSpec.authenticated({
		summary: "Test a device's SSH login",
		description:
			"The device's agent logs in with each of its two keys (without running anything) and " +
			"reports the device's host key fingerprint and which keys the device accepts. Trust the " +
			"host key with `POST /ssh/trust` to allow shutdown and reboot.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("SSH login tested", DevicesModel.Ssh.TestResponse),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device or SSH login not found"),
			APIResponseSpec.conflict("SSH is off, or no agent is assigned to the device"),
			APIResponseSpec.serviceUnavailable("The agent is offline"),
			APIResponseSpec.gatewayTimeout("The agent didn't answer in time"),
		),
	}),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");

		if (!(await SshLogins.enabled())) return APIResponse.conflict(c, SSH_DISABLED);

		const login = SshLogins.get(device.id);
		const target = login ? SshLogins.target(device, login) : null;
		if (!login || !target) return APIResponse.notFound(c, "SSH login not found");

		const agent = SshLogins.agentFor(device);
		if (!agent) {
			return device.agent_id === null
				? APIResponse.conflict(c, "No agent is assigned to this device")
				: APIResponse.serviceUnavailable(c, "The device's agent is offline or can't log in over SSH");
		}

		try {
			// Two logins (one per key), each with the agent's own connect timeout.
			const result = await agent.request("SSH_CHECK", target, 25_000);
			return APIResponse.success(c, "SSH login tested", {
				online: result.online,
				host_key: result.host_key ?? null,
				trusted: !!result.host_key && result.host_key === login.host_key,
				shutdown: result.shutdown ?? false,
				reboot: result.reboot ?? false,
				error: result.error ?? null,
			} satisfies DevicesModel.Ssh.TestResponse);
		} catch (error) {
			if (!(error instanceof AgentRequestError)) throw error;
			if (error.reason === "timeout")
				return APIResponse.gatewayTimeout(c, "The agent didn't answer in time");
			if (error.reason === "offline") return APIResponse.serviceUnavailable(c, "The agent is offline");
			return APIResponse.badGateway(c, error.message);
		}
	},
);

router.post(
	"/:deviceID/ssh/trust",

	APIRouteSpec.authenticated({
		summary: "Trust a device's SSH host key",
		description:
			"Stores the fingerprint from a test login. Logins to another host key fail from then on.",
		tags: [DOCS_TAGS.DEVICES],
		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Host key trusted", DevicesModel.Ssh.Response),
			APIResponseSpec.forbidden("Only the device's owner can do this"),
			APIResponseSpec.notFound("Device or SSH login not found"),
			APIResponseSpec.conflict("SSH is turned off on this server"),
		),
	}),

	validator("json", DevicesModel.Ssh.TrustBody),

	async (c) => {
		const device = getDevice(c);
		if (!DevicePermissions.can(device.access_role, "manage")) return forbidden(c, "manage");
		if (!(await SshLogins.enabled())) return APIResponse.conflict(c, SSH_DISABLED);
		if (!SshLogins.get(device.id)) return APIResponse.notFound(c, "SSH login not found");

		SshLogins.trust(device.id, c.req.valid("json").host_key);
		return APIResponse.success(c, "Host key trusted", await toSshResponse(device));
	},
);
