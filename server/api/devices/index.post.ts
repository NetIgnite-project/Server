import { DBStorage } from '~/server/db';
import { UserAuthInfo } from '~/server/utils/auth/handler';
import { Validation } from '~/server/utils/validation';

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const input = Validation.parseDeviceInput(await readBody(event));
    if (!input) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload", data: null  };
    }

    // Devices can only be bound to the user's own agents.
    const agent = await DBStorage.Agents.getByIDAndOwnerID(input.agentID, userinfo.userID);
    if (!agent) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "No matching agent found for the given AgentID", data: null };
    }

    const result = await DBStorage.Devices.insert({ ...input, ownerID: userinfo.userID });
    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to create Device", data: null };
    }

    setResponseStatus(event, 201);
    return { status: "OK", message: "Device created successfully", data: result  };
});
