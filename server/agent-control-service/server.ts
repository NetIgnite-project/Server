import { Logger } from "../utils/logger";
import type { ControllableAgent, AgentsDB } from "./agent";
import type { Hooks as WSHooks } from "crossws"
import { CronJob } from "cron";

class ControlServiceServerUtils {

    private static getBasicAuthCredentials(req: Request) {
        try {
            const authHeader = req.headers.get("authorization");
            if (!authHeader) return null;

            const [type, credentials] = authHeader.split(" ");
            if (type !== "Basic" || !credentials) return null;

            const decoded = Buffer.from(credentials, "base64").toString("utf8");
            const [raw_id, secret] = decoded.split(":");

            if (!raw_id || !secret) return null;
            const id = parseInt(raw_id, 10);
            if (Number.isNaN(id) || !Number.isSafeInteger(id)) return null;

            return { id, secret };
        } catch {
            return null;
        }
    }

    static getAgent(req: Request, agents: AgentsDB) {

        const credentials = this.getBasicAuthCredentials(req);
        if (!credentials) return null;

        const agent = agents.get(credentials.id);
        if (!agent) return null;

        if (agent.secret !== credentials.secret) return null;

        return agent;

    }

}

function ControlServiceServerHandlerFactory(clients: Map<string, ControllableAgent>, agents: AgentsDB): Partial<WSHooks> {
    return {
        async open(peer) {

            const agent = ControlServiceServerUtils.getAgent(peer.request as Request, agents);
            if (!agent) {
                peer.close(1008, "Missing or invalid credentials");
                return;
            }

            if (agent.isOnline()) {
                Logger.log(`Agent '${agent.id}' is already connected. Closing previous connection.`);
                await agent.closeConnection();
            }

            agent.peerID = peer.id;
            agent.socket = peer;
            clients.set(peer.id, agent);
            Logger.log(`Agent '${agent.id}' connected`);
        },

        message(peer, message) {
            const agent = clients.get(peer.id);
            if (agent?.onMessage) {
                agent.onMessage(message.text());
            }
        },

        error(peer, error) {
            const agent = clients.get(peer.id);
            Logger.error(`WebSocket error: ${error} on agent '${agent ? agent.id : "unknown"}'`);
        },

        close(peer, { code, reason }) {
            const agent = clients.get(peer.id);
            if (agent) {
                agent.peerID = null;
                agent.socket = null;
                agent.onMessage = null;
                clients.delete(peer.id);
                Logger.log(`Agent '${agent.id}' disconnected with code ${code} and reason: ${reason}`);
            }
        }
    }
}


export class ControlServiceServer {

    private readonly handler: Partial<WSHooks>;

    readonly clients: Map<string, ControllableAgent> = new Map();

    private readonly heartbeatJob: CronJob = new CronJob("* * * * *", async () => {

        const promises: Promise<void>[] = [];

        for (const agent of this.clients.values()) {
            promises.push(agent.sendHeartbeat());
        }

        await Promise.all(promises);
    });

    constructor(
        private readonly agents: AgentsDB
    ) {
        this.handler = ControlServiceServerHandlerFactory(this.clients, this.agents);

        // Heartbeat job to send heartbeat to all connected agents every 60 seconds
        this.heartbeatJob.start();
    }

    public getWebSocketHandler() {
        return this.handler;
    }
}