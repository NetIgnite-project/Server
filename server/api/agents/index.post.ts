import { AgentControlService } from "~/server/agent-control-service";
import { DBStorage } from "../../db";
import { ControllableAgent } from "~/server/agent-control-service/agent";
import { AgentSecrets } from "~/server/utils/auth/agentSecrets";
import { Validation } from "~/server/utils/validation";

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const input = Validation.parseAgentInput(await readBody(event));
    if (!input) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload", data: null };
    }

    // The secret is generated here and returned only in this response; only its hash is stored.
    const secret = AgentSecrets.generate();
    const agent: DBStorage.Agent.ModelWithoutID = {
        ...input,
        secretHash: AgentSecrets.hash(secret),
        ownerID: userinfo.userID,
    };

    const id = await DBStorage.Agents.insert(agent);
    if (!id) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to create Agent", data: null };
    }

    AgentControlService.agents.set(id, ControllableAgent.fromConfig({ ...agent, id }));

    setResponseStatus(event, 201);
    return { status: "OK", message: "Agent created successfully", data: { id, secret } };
});
