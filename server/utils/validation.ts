import type { AgentsTable } from "../db/models/agents";
import type { DevicesTable } from "../db/models/devices";

const AGENT_TYPES: readonly AgentsTable.Model.Type[] = ["server", "microcontroller"];
const DEVICE_TYPES: readonly DevicesTable.Model.Type[] = ["server", "desktop", "laptop", "printer", "nas"];

// The formats agents accept: six hex pairs separated by colons or by dashes.
const MAC_ADDRESS_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$|^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/;

export namespace Validation {

    export type AgentInput = Pick<AgentsTable.Model, "name" | "type" | "description">;
    export type DeviceInput = Pick<DevicesTable.Model, "name" | "type" | "description" | "macAddress" | "port" | "agentID">;

    export function isMacAddress(value: unknown): value is string {
        return typeof value === "string" && MAC_ADDRESS_REGEX.test(value);
    }

    export function isPort(value: unknown): value is number {
        return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
    }

    /** The editable fields of an agent, or null if the payload is invalid. */
    export function parseAgentInput(payload: any): AgentInput | null {
        if (
            !payload ||
            typeof payload.name !== "string" ||
            typeof payload.description !== "string" ||
            !AGENT_TYPES.includes(payload.type)
        ) {
            return null;
        }
        return { name: payload.name, type: payload.type, description: payload.description };
    }

    /** The editable fields of a device, or null if the payload is invalid. */
    export function parseDeviceInput(payload: any): DeviceInput | null {
        if (
            !payload ||
            typeof payload.name !== "string" ||
            !DEVICE_TYPES.includes(payload.type) ||
            (payload.description !== undefined && payload.description !== null && typeof payload.description !== "string") ||
            !isMacAddress(payload.macAddress) ||
            !isPort(payload.port) ||
            typeof payload.agentID !== "number" || !Number.isSafeInteger(payload.agentID)
        ) {
            return null;
        }
        return {
            name: payload.name,
            type: payload.type,
            description: payload.description ?? "",
            macAddress: payload.macAddress,
            port: payload.port,
            agentID: payload.agentID,
        };
    }

}
