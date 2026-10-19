import { AgentRequestError } from "../agents/connection";
import { AgentRegistry } from "../agents/registry";
import type { DB } from "../db";

export class DeviceActionError extends Error {
	constructor(
		/** HTTP status the API answers with. */
		readonly status: 409 | 502 | 503 | 504,
		message: string,
	) {
		super(message);
	}
}

/** Power actions on devices. Callers check {@link DevicePermissions} first. */
export class DeviceActions {
	/** Sends Wake-on-LAN through the device's agent. */
	static async powerOn(device: DB.Models.Device) {
		if (device.agent_id === null) {
			throw new DeviceActionError(409, "No agent is assigned to this device");
		}

		const connection = AgentRegistry.get(device.agent_id);
		if (!connection) throw new DeviceActionError(503, "Agent is offline");

		await this.run(() =>
			connection.request("WAKE", { mac: device.mac_address, port: device.wol_port }),
		);
	}

	/** Shuts down or reboots the device through the Linux agent running on it. */
	static async hostControl(device: DB.Models.Device, action: "shutdown" | "reboot") {
		if (device.host_agent_id === null) {
			throw new DeviceActionError(409, `No ${action} method is configured for this device`);
		}

		const connection = AgentRegistry.get(device.host_agent_id);
		if (!connection) throw new DeviceActionError(503, "The device's host agent is offline");

		await this.run(() => connection.request("HOST_CONTROL", { action }, 10_000));
	}

	/** Which power actions are currently possible, for the dashboard. */
	static availableActions(device: DB.Models.Device) {
		const wolAgent = device.agent_id !== null ? AgentRegistry.get(device.agent_id) : null;
		const hostAgent = device.host_agent_id !== null ? AgentRegistry.get(device.host_agent_id) : null;

		return {
			power_on: wolAgent?.hasCapability("wake") ?? false,
			shutdown: hostAgent?.hasCapability("host.control") ?? false,
			reboot: hostAgent?.hasCapability("host.control") ?? false,
		};
	}

	private static async run(request: () => Promise<unknown>) {
		try {
			await request();
		} catch (error) {
			if (!(error instanceof AgentRequestError)) throw error;

			switch (error.reason) {
				case "offline":
					throw new DeviceActionError(503, "Agent is offline");
				case "unsupported":
					throw new DeviceActionError(409, "The agent doesn't support this action");
				case "timeout":
					throw new DeviceActionError(504, "The agent didn't answer in time");
				case "rejected":
					throw new DeviceActionError(502, `The agent reported an error: ${error.message}`);
			}
		}
	}
}
