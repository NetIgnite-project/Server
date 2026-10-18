import { describe, test, expect } from "bun:test";
import { AgentSecrets } from "@/server/utils/auth/agentSecrets";
import { Validation } from "@/server/utils/validation";
import { ControllableAgent } from "@/server/agent-control-service/agent";
import { AgentCommand, AgentResponse } from "@/server/agent-control-service/commands/message";

describe('agent_secrets', () => {

    test('generated secrets are random 32-character hex strings', () => {
        const a = AgentSecrets.generate();
        const b = AgentSecrets.generate();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
    });

    test('hash verifies only the matching secret', () => {
        const secret = AgentSecrets.generate();
        const hash = AgentSecrets.hash(secret);

        expect(hash).not.toContain(secret);
        expect(AgentSecrets.isHash(hash)).toBe(true);
        expect(AgentSecrets.verify(secret, hash)).toBe(true);
        expect(AgentSecrets.verify(secret + "x", hash)).toBe(false);
        expect(AgentSecrets.verify("", hash)).toBe(false);
    });

    test('plaintext values are not treated as hashes', () => {
        expect(AgentSecrets.isHash("123456")).toBe(false);
        expect(AgentSecrets.isHash("sha256:not-a-hash")).toBe(false);
        // A plaintext secret stored by an old version must never verify against itself.
        expect(AgentSecrets.verify("123456", "123456")).toBe(false);
    });

    test('legacy secrets keep working after migration', () => {
        const legacySecret = "with:colon";
        expect(AgentSecrets.verify(legacySecret, AgentSecrets.hash(legacySecret))).toBe(true);
    });

});

describe('payload_validation', () => {

    const device: Validation.DeviceInput = {
        name: "PC",
        type: "desktop",
        description: "Office",
        macAddress: "AA:BB:CC:DD:EE:FF",
        port: 9,
        agentID: 1,
    };

    test('valid device payloads are accepted', () => {
        expect(Validation.parseDeviceInput(device)).toEqual(device);
        expect(Validation.parseDeviceInput({ ...device, macAddress: "aa-bb-cc-dd-ee-ff" })).not.toBeNull();
        expect(Validation.parseDeviceInput({ ...device, description: undefined })?.description).toBe("");
    });

    test('invalid device payloads are rejected', () => {
        expect(Validation.parseDeviceInput(null)).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, type: "toaster" })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, macAddress: "AABBCCDDEEFF" })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, macAddress: "AA:BB-CC:DD:EE:FF" })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, port: 0 })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, port: 9.5 })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, port: 65536 })).toBeNull();
        expect(Validation.parseDeviceInput({ ...device, agentID: "1" })).toBeNull();
    });

    test('agent payloads only carry editable fields', () => {
        const input = Validation.parseAgentInput({
            name: "ESP32", type: "microcontroller", description: "", secret: "chosen", ownerID: 99, id: -1,
        });
        expect(input).toEqual({ name: "ESP32", type: "microcontroller", description: "" });
        expect(Validation.parseAgentInput({ name: "x", type: "robot", description: "" })).toBeNull();
    });

});

describe('agent_commands', () => {

    function connectedAgent() {
        const sent: string[] = [];
        const agent = new ControllableAgent(1, 1, AgentSecrets.hash("secret"));
        agent.peerID = "peer";
        agent.socket = {
            websocket: { readyState: WebSocket.OPEN },
            send: (data) => { sent.push(String(data)); },
            close: () => {},
        };
        return { agent, sent };
    }

    test('concurrent commands each receive their own response', async () => {
        const { agent, sent } = connectedAgent();

        const wakeup = agent.sendCommand("WAKEUP", { macAddress: "AA:BB:CC:DD:EE:FF", port: 9 });
        const status = agent.sendCommand("GET_STATUS", { address: "AA:BB:CC:DD:EE:FF" });

        const [wakeupCmd, statusCmd] = sent.map((data) => AgentCommand.fromDecoded(data));
        if (!wakeupCmd || !statusCmd) throw new Error("commands were not sent");

        // Answer in reverse order.
        agent.handleMessage(new AgentResponse("GET_STATUS", statusCmd.id, { status: "OK", message: "", online: "online" }).encode());
        agent.handleMessage(new AgentResponse("WAKEUP", wakeupCmd.id, { status: "OK", message: "Wakeup successful" }).encode());

        expect(await status).toEqual({ status: "OK", message: "", online: "online" });
        expect(await wakeup).toEqual({ status: "OK", message: "Wakeup successful" });
    });

    test('pending commands fail when the connection is detached', async () => {
        const { agent } = connectedAgent();

        const wakeup = agent.sendCommand("WAKEUP", { macAddress: "AA:BB:CC:DD:EE:FF", port: 9 });
        agent.detachConnection();

        expect(await wakeup).toBeNull();
        expect(agent.isOnline()).toBe(false);
    });

});
