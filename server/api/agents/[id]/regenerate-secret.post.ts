import { UserAuthInfo } from "@/server/utils/auth/handler";
import { DBStorage } from "@/server/db";
import { AgentControlService } from "~/server/agent-control-service";
import { AgentSecrets } from "~/server/utils/auth/agentSecrets";

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const agentID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(agentID) || !Number.isSafeInteger(agentID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Agent ID", data: null };
    }

    const secret = AgentSecrets.generate();
    const secretHash = AgentSecrets.hash(secret);

    const result = await DBStorage.Agents.updateSecretHashByOwner(agentID, userinfo.userID, secretHash);

    if (result === null) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to regenerate secret", data: null };
    }

    if (!result) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Agent not found or inaccessible by user", data: null };
    }

    // The old secret is invalid now: disconnect the agent until it reconnects with the new one.
    const controllableAgent = AgentControlService.agents.get(agentID);
    if (controllableAgent) {
        controllableAgent.secretHash = secretHash;
        await controllableAgent.closeConnection();
    }

    setResponseStatus(event, 200);
    return { status: "OK", message: "Secret regenerated successfully", data: { id: agentID, secret } };
});
