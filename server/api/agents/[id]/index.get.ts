import { UserAuthInfo } from "@/server/utils/auth/handler";
import { DBStorage } from "@/server/db";

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const agentID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(agentID) && !Number.isSafeInteger(agentID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Agent ID", data: null  };
    }

    const agent = await DBStorage.Agents.getByIDAndOwnerID(agentID, userinfo.userID);
    if (!agent || agent.ownerID !== userinfo.userID) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Agent not found or inaccessible by user", data: null };
    }

    setResponseStatus(event, 200);
    return { status: "OK", message: "Agent retrieved successfully", data: DBStorage.Agent.toPublic(agent) };
});
