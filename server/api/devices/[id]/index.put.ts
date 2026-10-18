import { DBStorage } from "../../../db";
import { Validation } from "~/server/utils/validation";

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const deviceID = parseInt(getRouterParam(event, "id") as string, 10);
    if (Number.isNaN(deviceID) || !Number.isSafeInteger(deviceID)) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid Device ID" };
    }

    const input = Validation.parseDeviceInput(await readBody(event));
    if (!input) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "Invalid payload" };
    }

    const device = await DBStorage.Devices.getByIDAndOwnerID(deviceID, userinfo.userID);
    if (!device) {
        setResponseStatus(event, 404);
        return { status: "ERROR", message: "Device not found or inaccessible by user" };
    }

    // Devices can only be bound to the user's own agents.
    const agent = await DBStorage.Agents.getByIDAndOwnerID(input.agentID, userinfo.userID);
    if (!agent) {
        setResponseStatus(event, 400);
        return { status: "ERROR", message: "No matching agent found for the given AgentID", data: null };
    }

    const result = await DBStorage.Devices.updateByOwner({ ...input, id: deviceID, ownerID: userinfo.userID });
    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to update Device" };
    }

    setResponseStatus(event, 201);
    return { status: "OK", message: "Device updated successfully" };
});
