import type { UserAuthInfo } from '@/server/utils/auth/handler';
import { AgentControlService } from '~/server/agent-control-service';
import { DBStorage } from '~/server/db';
import type { ModelUtils } from '~/utils/models/utils';

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const idList = getQuery(event).ids?.toString().split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    const result: {
        [id: string]: ModelUtils.OnlineStatus.Type
    } = {};

    const ownedDevices = await DBStorage.Devices.getAllByOwnerID(userinfo.userID);
    if (!ownedDevices) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to retrieve devices statuses.", data: null };
    }

    for (const device of ownedDevices) {

        if (idList && !idList.includes(device.id)) {
            continue;
        }

        const agent = AgentControlService.agents.get(device.agentID);
        if (!agent || agent.ownerID !== userinfo.userID) {
            result[device.id.toString()] = "unknown";
            continue;
        }

        const deviceStatus = await agent.sendCommand("GET_STATUS", {
            address: device.macAddress,
        });
        if (deviceStatus?.online) {
            result[device.id.toString()] = deviceStatus.online as ModelUtils.OnlineStatus.Type;
        } else {
            result[device.id.toString()] = "unknown";
        }

    }
    
    return { status: "OK", data: result};
});