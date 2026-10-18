import { DBStorage } from "../../../db";
import { Validation } from "~/server/utils/validation";

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const agentID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(agentID) || !Number.isSafeInteger(agentID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Agent ID" };
    }

    // The secret can't be set here; use POST /api/agents/:id/regenerate-secret.
    const input = Validation.parseAgentInput(await readBody(event));
    if (!input) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload" };
    }

    const result = await DBStorage.Agents.updateDetailsByOwner({
        ...input,
        id: agentID,
        ownerID: userinfo.userID,
    });

    if (result === null) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to update Agent" };
    }

    if (!result) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Agent not found or inaccessible by user" };
    }

    setResponseStatus(event, 201);
    return { status: "OK", message: "Agent updated successfully" };
});
