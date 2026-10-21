import { and, eq, inArray, or } from "drizzle-orm";
import type { ShareSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";
import type { DrizzleDB } from "../db/utils";

/**
 * Who may do what with a device. The owner can do everything; other users get a role per share.
 *
 * | Action   | owner | manager | operator | viewer |
 * | -------- | ----- | ------- | -------- | ------ |
 * | `read`   | ✓     | ✓       | ✓        | ✓      |
 * | `power`  | ✓     | ✓       | ✓        |        |
 * | `edit`   | ✓     | ✓       |          |        |
 * | `manage` | ✓     |         |          |        |
 *
 * `manage` covers sharing, deleting, choosing the agents and credentials (agents are never shared).
 */
export class DevicePermissions {
	static readonly ACTIONS_BY_ROLE: Record<
		DevicePermissions.AccessRole,
		readonly DevicePermissions.Action[]
	> = {
		owner: ["read", "power", "edit", "manage"],
		manager: ["read", "power", "edit"],
		operator: ["read", "power"],
		viewer: ["read"],
	};

	static can(role: DevicePermissions.AccessRole, action: DevicePermissions.Action) {
		return this.ACTIONS_BY_ROLE[role].includes(action);
	}

	/** The device and the user's role on it, or null if the user has no access. */
	static async getAccess(
		userID: number,
		deviceID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<DevicePermissions.DeviceWithRole | null> {
		const device = await tx
			.select()
			.from(DB.Tables.devices)
			.where(eq(DB.Tables.devices.id, deviceID))
			.get();
		if (!device) return null;

		if (device.owner_id === userID) return { ...device, access_role: "owner" };

		const share = await tx
			.select({ role: DB.Tables.deviceShares.role })
			.from(DB.Tables.deviceShares)
			.where(
				and(eq(DB.Tables.deviceShares.device_id, deviceID), eq(DB.Tables.deviceShares.user_id, userID)),
			)
			.get();

		return share ? { ...device, access_role: share.role } : null;
	}

	/** All devices the user owns or that are shared with them, each with the user's role. */
	static async listAccessible(
		userID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<DevicePermissions.DeviceWithRole[]> {
		const shares = await tx
			.select({ device_id: DB.Tables.deviceShares.device_id, role: DB.Tables.deviceShares.role })
			.from(DB.Tables.deviceShares)
			.where(eq(DB.Tables.deviceShares.user_id, userID));
		const roleByDevice = new Map(shares.map((share) => [share.device_id, share.role]));

		const devices = await tx
			.select()
			.from(DB.Tables.devices)
			.where(
				shares.length > 0
					? or(
							eq(DB.Tables.devices.owner_id, userID),
							inArray(DB.Tables.devices.id, [...roleByDevice.keys()]),
						)
					: eq(DB.Tables.devices.owner_id, userID),
			)
			.orderBy(DB.Tables.devices.name);

		return devices.map((device) => ({
			...device,
			access_role: device.owner_id === userID ? "owner" : (roleByDevice.get(device.id) ?? "viewer"),
		}));
	}
}

export namespace DevicePermissions {
	export type Action = "read" | "power" | "edit" | "manage";
	export type AccessRole = "owner" | ShareSettings.Role;
	export type DeviceWithRole = DB.Models.Device & { access_role: AccessRole };
}
