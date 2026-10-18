import { AgentControlService } from '@/server/agent-control-service';
import { DBStorage } from '~/server/db';
import { UserAuthInfo } from '~/server/utils/auth/handler';

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const deviceID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(deviceID) && !Number.isSafeInteger(deviceID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Device ID" };
    }

    const device = await DBStorage.Devices.getByID(deviceID);
    if (!device || device.ownerID !== userinfo.userID) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Device not found or inaccessible by user" };
    }

    // Devices created before agent ownership was enforced may point at another user's agent.
    const agent = AgentControlService.agents.get(device.agentID);
    if (!agent || agent.ownerID !== userinfo.userID) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Agent not found" };
    }

    if (!agent.isOnline()) {
        setResponseStatus(event, 503);
        return { status: "ERROR", message: "Agent is offline" };
    }

    let result = null;
    try {
        result = await agent.sendCommand("WAKEUP", {
            macAddress: device.macAddress,
            port: device.port
        });
    } catch {}

    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: `Failed to send wakeup command` };
    }

    if (result?.status !== "OK") {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Wakeup command failed: " + result?.message };
    }

    setResponseStatus(event, 200);
    return { status: "OK", message: "Wakeup command sent" };

});


// type WakeupPayload = {
//     macAddress: string;
// }

// export default defineEventHandler(async (event) => {

//     const session = SessionHandler.isAuthenticatedSession(event);
//     if (!session) return;

//     const agentID = parseInt(getRouterParam(event, "id") as string, 10);
//     if (Number.isNaN(agentID) && !Number.isSafeInteger(agentID)) {
//         setResponseStatus(event, 400);
//         return { status: "ERROR", message: "Invalid Agent ID" };
//     }

//     const payload = await readBody(event) as WakeupPayload | undefined;

//     const macAddress = payload?.macAddress;

//     if (typeof macAddress !== "string") {
//         setResponseStatus(event, 400);
//         return { status: "ERROR", message: "Invalid MAC-Address" };
//     }

//     const agent = AgentControlService.agents.get(agentID);
//     if (!agent) {
//         setResponseStatus(event, 404);
//         return { status: "ERROR", message: "Agent not found" };
//     }

//     if (!agent.isOnline()) {
//         setResponseStatus(event, 503);
//         return { status: "ERROR", message: "Agent is offline" };
//     }

//     let result = null;
//     try {
//         result = await agent.sendCommand("WAKEUP", {
//             macAddress: macAddress,
//             port: 9
//         });
//     } catch {}

//     if (!result) {
//         setResponseStatus(event, 500);
//         return { status: "ERROR", message: `Failed to send wakeup command` };
//     }

//     if (result?.status !== "OK") {
//         setResponseStatus(event, 500);
//         return { status: "ERROR", message: "Wakeup command failed: " + result?.message };
//     }

//     setResponseStatus(event, 200);
//     return { status: "OK", message: "Wakeup command sent" };
// });
