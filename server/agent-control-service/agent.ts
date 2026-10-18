import { EncodingUtils } from "@/shared/encoding";
import { AgentCMDRegistry } from "./commands/registry";
import { AgentCommand } from "./commands/message";
import { AgentControlService } from ".";
import { AgentSecrets } from "../utils/auth/agentSecrets";

export type AgentID = number;
export type AgentsDB = Map<AgentID, ControllableAgent>;

type Socket = {
    websocket: {
        readyState?: number | undefined;
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
    close(): void;
}

type ControllableOnlineAgent = ControllableAgent & {
    peerID: string;
    socket: Socket;
}

const COMMAND_RESPONSE_TIMEOUT_MS = 5000;


export class ControllableAgent implements ControllableAgent.IConfig {

    public peerID: string | null = null;
    public socket: Socket | null = null;

    /** Commands waiting for a response, by command ID. Several commands can be in flight at once. */
    private readonly pendingResponses = new Map<number, (payload: any) => void>();

    constructor(
        readonly id: number,
        readonly ownerID: number,
        public secretHash: string,
    ) { }

    static fromConfig(config: ControllableAgent.IConfig) {
        return new ControllableAgent(
            config.id,
            config.ownerID,
            config.secretHash
        );
    }

    public verifySecret(secret: string) {
        return AgentSecrets.verify(secret, this.secretHash);
    }

    public isOnline(): this is ControllableOnlineAgent {
        return this.socket !== null && this.peerID !== null && this.socket.websocket.readyState === WebSocket.OPEN;
    }

    async sendCommand<C extends AgentCMDRegistry.Commands>(command: C, payload: AgentCMDRegistry.Payload<C>, withResponse?: true): Promise<AgentCMDRegistry.Response<C> | null>;
    async sendCommand<C extends AgentCMDRegistry.Commands>(command: C, payload: AgentCMDRegistry.Payload<C>, withResponse: false): Promise<void>;
    async sendCommand<C extends AgentCMDRegistry.Commands>(command: C, payload: AgentCMDRegistry.Payload<C>, withResponse: boolean): Promise<AgentCMDRegistry.Response<C> | null | void>;
    async sendCommand<C extends AgentCMDRegistry.Commands>(command: C, payload: AgentCMDRegistry.Payload<C>, withResponse = true): Promise<AgentCMDRegistry.Response<C> | null | void> {
        if (!this.isOnline()) {
            return null;
        }

        const cmd = AgentCommand.create(command as any, payload as any);
        const responseID = cmd.id;

        if (!withResponse) {
            this.socket.send(cmd.encode());
            return;
        }

        const response = new Promise<AgentCMDRegistry.Response<C> | null>((resolve) => {

            const timeout = setTimeout(() => {
                this.pendingResponses.delete(responseID);
                resolve(null);
            }, COMMAND_RESPONSE_TIMEOUT_MS);

            this.pendingResponses.set(responseID, (responsePayload) => {
                clearTimeout(timeout);
                this.pendingResponses.delete(responseID);
                resolve(responsePayload);
            });

        });

        this.socket.send(cmd.encode());

        return response;
    }

    /** Resolves the pending command that a message from the agent answers. */
    public handleMessage(data: string) {
        const decoded = AgentCommand.fromDecoded(data);
        if (!decoded) return;

        this.pendingResponses.get(decoded.id)?.(decoded.payload);
    }

    async sendHeartbeat() {
        if (this.isOnline()) {
            const cmd = AgentCommand.create("HEARTBEAT", {});
            this.socket.send(cmd.encode());
        }
    }

    /** Forgets the connection and fails all commands still waiting for a response. */
    public detachConnection() {
        this.peerID = null;
        this.socket = null;

        for (const resolve of this.pendingResponses.values()) {
            resolve(null);
        }
    }

    async closeConnection() {
        if (this.isOnline()) {
            const clients = await AgentControlService.getClients();
            clients.delete(this.peerID);
            const socket = this.socket;

            this.detachConnection();
            socket.close();
        }
    }

}

export namespace ControllableAgent {
    export interface IConfig {
        id: AgentID;
        ownerID: number;
        secretHash: string;
    }
}

