import { EncodingUtils } from "@/shared/encoding";
import { AgentCMDRegistry } from "./commands/registry";
import { AgentCommand } from "./commands/message";
import { AgentControlService } from ".";

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


export class ControllableAgent implements ControllableAgent.IConfig {

    public peerID: string | null = null;
    public socket: Socket | null = null;
    
    public onMessage: ((data: string) => void) | null = null;

    constructor(
        readonly id: number,
        public secret: string,
    ) { }

    static fromConfig(config: ControllableAgent.IConfig) {
        return new ControllableAgent(
            config.id,
            config.secret
        );
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
        const response_id = cmd.id;

        this.socket.send(cmd.encode());

        if (!withResponse) return;

        return new Promise<AgentCMDRegistry.Response<C> | null>((resolve) => {

            this.onMessage = (data) => {

                const decoded = AgentCommand.fromDecoded(data);
                if (decoded && decoded.id === response_id) {
                    clearTimeout(timeout);
                    this.onMessage = null;
                    resolve(decoded.payload);
                }
            };

            const timeout = setTimeout(() => {
                this.onMessage = null;
                resolve(null);
            }, 5000);

        });


    }

    async sendHeartbeat() {
        if (this.isOnline()) {
            const cmd = AgentCommand.create("HEARTBEAT", {});
            this.socket.send(cmd.encode());
        }
    }

    async closeConnection() {
        if (this.isOnline()) {
            const clients = await AgentControlService.getClients();
            clients.delete(this.peerID as string);
            this.socket.close();

            (this.peerID as any) = null;
            (this.socket as any) = null;
            (this.onMessage as any) = null;
        }
    }

}

export namespace ControllableAgent {
    export interface IConfig {
        id: AgentID;
        // name: string;
        secret: string;
    }
}

