import { DBStorage } from "../../../db";

type UpdatePayload = DBStorage.Device.Model;

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const deviceID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(deviceID) || !Number.isSafeInteger(deviceID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Device ID" };
    }

    const payload = await readBody(event) as UpdatePayload | undefined;
    if (
        !payload ||
        typeof payload.name !== "string" ||
        typeof payload.macAddress !== "string" ||
        typeof payload.port !== "number" || payload.port < 0 || payload.port > 65535 ||
        typeof payload.agentID !== "number"
    ) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload" };
    }

    payload.ownerID = userinfo.userID;
    payload.id = deviceID;

    const agentIDExists = await DBStorage.Agents.getByID(payload.agentID);
    if (!agentIDExists) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "No matching agent found for the given AgentID", data: null };
    }

    const result = await DBStorage.Devices.updateByOwner(payload);
    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to update Device" };
    }

    setResponseStatus(event, 201);
    return { status: "OK", message: "Device updated successfully" };
});