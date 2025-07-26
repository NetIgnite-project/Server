import { AgentControlService } from "~/server/agent-control-service";
import { DBStorage } from "../../../db";
import { ControllableAgent } from "~/server/agent-control-service/agent";

type UpdatePayload = DBStorage.Agent.Model;

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const agentID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(agentID) || !Number.isSafeInteger(agentID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Agent ID" };
    }

    const payload = await readBody(event) as UpdatePayload | undefined;
    if (
        !payload ||
        typeof payload.name !== "string" ||
        typeof payload.description !== "string" ||
        !["server", "microcontroller"].includes(payload.type) ||
        typeof payload.secret !== "string"
    ) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload" };
    }

    payload.ownerID = userinfo.userID;
    payload.id = agentID;

    const result = await DBStorage.Agents.updateByOwner(payload);
    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to update Agent" };
    }

    const controllableAgent = AgentControlService.agents.get(agentID) as ControllableAgent;
    if (controllableAgent) {
        if (controllableAgent.secret !== payload.secret) {
            controllableAgent.secret = payload.secret;

            // If the secret has changed, we need to close the connection
            await controllableAgent.closeConnection();
        }
    }

    setResponseStatus(event, 201);
    return { status: "OK", message: "Agent updated successfully" };
});