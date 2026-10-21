import { isIP } from "node:net";
import { ne } from "drizzle-orm";
import { AgentRequestError } from "../agents/connection";
import { AgentGatewayRunner } from "../agents/gateway";
import type { AgentProtocol } from "../agents/protocol";
import { AgentRegistry } from "../agents/registry";
import type { DeviceSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";
import { Logger } from "../utils/logger";

export type DeviceStatus = {
	state: DeviceSettings.OnlineState;
	/** Unix ms of the last check, null if never checked. */
	checked_at: number | null;
	/** Why the state is `unknown`, if it is. */
	reason?: string;
};

/**
 * Checks device status in the background and caches the result, so dashboards read the cache
 * instead of making agents ping on every page load. Checks of one agent run one at a time;
 * different agents are checked in parallel.
 */
export class DeviceStatusService {
	static readonly INTERVAL_MS = 20_000;
	static readonly CHECK_TIMEOUT_MS = 6_000;
	/** Minimum time between two on-demand checks of the same device. */
	static readonly MANUAL_REFRESH_MIN_INTERVAL_MS = 5_000;

	private static readonly cache = new Map<number, DeviceStatus>();
	private static timer: ReturnType<typeof setInterval> | null = null;
	private static running = false;
	private static readonly agentQueues = new Map<number, Promise<unknown>>();

	static start() {
		if (this.timer) return;

		this.timer = setInterval(() => void this.refreshAll(), this.INTERVAL_MS);
		this.timer.unref?.();

		// A device's status changes as soon as its agent comes back.
		AgentGatewayRunner.onHello((connection) => void this.refreshAgent(connection.agentID));
	}

	static stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	static get(deviceID: number): DeviceStatus {
		return this.cache.get(deviceID) ?? { state: "unknown", checked_at: null };
	}

	static forget(deviceID: number) {
		this.cache.delete(deviceID);
	}

	/** Checks one device now (rate limited per device) and returns the new status. */
	static async refresh(device: DB.Models.Device) {
		const cached = this.cache.get(device.id);
		if (cached?.checked_at && Date.now() - cached.checked_at < this.MANUAL_REFRESH_MIN_INTERVAL_MS) {
			return cached;
		}
		return await this.check(device);
	}

	static async refreshAll() {
		if (this.running) return;
		this.running = true;

		try {
			const devices = await DB.instance()
				.select()
				.from(DB.Tables.devices)
				.where(ne(DB.Tables.devices.status_method, "none"));

			await Promise.all(devices.map((device) => this.check(device)));
		} catch (error) {
			Logger.error("Device status refresh failed", error);
		} finally {
			this.running = false;
		}
	}

	private static async refreshAgent(agentID: number) {
		const devices = await DB.instance().select().from(DB.Tables.devices);
		await Promise.all(
			devices
				.filter((device) => device.agent_id === agentID || device.host_agent_id === agentID)
				.map((device) => this.check(device)),
		);
	}

	private static async check(device: DB.Models.Device): Promise<DeviceStatus> {
		const status = await this.determine(device);
		this.cache.set(device.id, status);
		return status;
	}

	private static async determine(device: DB.Models.Device): Promise<DeviceStatus> {
		const now = Date.now();

		if (device.status_method === "none") {
			return { state: "unknown", checked_at: null, reason: "Status checks are turned off" };
		}

		if (device.status_method === "host_agent") {
			if (device.host_agent_id === null) {
				return { state: "unknown", checked_at: now, reason: "No host agent assigned" };
			}
			return {
				state: AgentRegistry.isOnline(device.host_agent_id) ? "online" : "offline",
				checked_at: now,
			};
		}

		const request = this.buildStatusRequest(device);
		if (!request) {
			return { state: "unknown", checked_at: now, reason: "No status address configured" };
		}
		if (device.agent_id === null) {
			return { state: "unknown", checked_at: now, reason: "No agent assigned" };
		}

		const connection = AgentRegistry.get(device.agent_id);
		if (!connection) {
			return { state: "unknown", checked_at: now, reason: "Agent is offline" };
		}

		try {
			const result = await this.enqueue(device.agent_id, () =>
				connection.request("STATUS", request, this.CHECK_TIMEOUT_MS),
			);
			return { state: result.online ? "online" : "offline", checked_at: Date.now() };
		} catch (error) {
			if (error instanceof AgentRequestError) {
				return { state: "unknown", checked_at: Date.now(), reason: error.message };
			}
			throw error;
		}
	}

	/** The STATUS request for a device, or null if its configuration is incomplete. */
	static buildStatusRequest(
		device: DB.Models.Device,
	): AgentProtocol.Commands["STATUS"]["req"] | null {
		const tcp_port = device.status_tcp_port ?? undefined;

		switch (device.status_method) {
			case "link_local":
				return { target: { type: "link_local", mac: device.mac_address }, icmp: true, tcp_port };
			case "ipv4":
			case "ipv6":
				return device.status_address
					? { target: { type: "ip", address: device.status_address }, icmp: true, tcp_port }
					: null;
			case "ssh": {
				if (!device.status_address) return null;
				const target: AgentProtocol.StatusTarget = isIP(device.status_address)
					? { type: "ip", address: device.status_address }
					: { type: "host", host: device.status_address };
				return { target, icmp: false, tcp_port: tcp_port ?? 22 };
			}
			default:
				return null;
		}
	}

	/** Runs checks of the same agent one after another. */
	private static enqueue<T>(agentID: number, task: () => Promise<T>): Promise<T> {
		const previous = this.agentQueues.get(agentID) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		this.agentQueues.set(agentID, next);
		void next
			.finally(() => {
				if (this.agentQueues.get(agentID) === next) this.agentQueues.delete(agentID);
			})
			.catch(() => undefined);
		return next;
	}
}
