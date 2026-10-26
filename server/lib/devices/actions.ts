import { AgentRequestError } from "../agents/connection";
import { AgentRegistry } from "../agents/registry";
import type { DB } from "../db";
import { SshLogins } from "../ssh/logins";

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

	/**
	 * Shuts down or reboots the device: through the agent running on it, or else (if an admin turned
	 * SSH on) over SSH through the device's network agent, with a trusted host key.
	 */
	static async hostControl(device: DB.Models.Device, action: "shutdown" | "reboot") {
		const hostAgent = device.host_agent_id !== null ? AgentRegistry.get(device.host_agent_id) : null;
		if (hostAgent?.hasCapability("host.control")) {
			await this.run(() => hostAgent.request("HOST_CONTROL", { action }, 10_000));
			return;
		}

		const login = await SshLogins.usable(device.id);
		const target = login ? SshLogins.target(device, login) : null;
		if (login && target) {
			if (!target.host_key) {
				throw new DeviceActionError(409, "Test the SSH login and trust the device's host key first");
			}
			const agent = SshLogins.agentFor(device);
			if (!agent) {
				throw new DeviceActionError(
					device.agent_id !== null && !AgentRegistry.get(device.agent_id) ? 503 : 409,
					device.agent_id === null
						? "No agent is assigned to this device"
						: AgentRegistry.get(device.agent_id)
							? "The device's agent can't log in over SSH"
							: "Agent is offline",
				);
			}
			await this.run(() =>
				agent.request(
					"SSH_POWER",
					{
						...target,
						host_key: target.host_key as string,
						action,
						os: login.os,
						sudo: SshLogins.sudo(login),
					},
					15_000,
				),
			);
			return;
		}

		if (device.host_agent_id !== null) {
			throw new DeviceActionError(503, "The device's host agent is offline");
		}
		throw new DeviceActionError(409, `No ${action} method is configured for this device`);
	}

	/**
	 * Which power actions are currently possible, for the dashboard. `sshTrusted`: SSH is on and the
	 * device has an SSH login with a trusted host key.
	 */
	static availableActions(device: DB.Models.Device, sshTrusted = false) {
		const wolAgent = device.agent_id !== null ? AgentRegistry.get(device.agent_id) : null;
		const hostAgent = device.host_agent_id !== null ? AgentRegistry.get(device.host_agent_id) : null;
		const control =
			(hostAgent?.hasCapability("host.control") ?? false) ||
			(sshTrusted && (wolAgent?.hasCapability("ssh.power") ?? false));

		return {
			power_on: wolAgent?.hasCapability("wake") ?? false,
			shutdown: control,
			reboot: control,
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
