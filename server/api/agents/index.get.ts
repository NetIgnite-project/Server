import { DBStorage } from '@/server/db';
import type { UserAuthInfo } from '@/server/utils/auth/handler';

export default defineEventHandler(async (event) => {

    const userinfo = event.context.userinfo as UserAuthInfo;
    if (!userinfo) return;

    const result = await DBStorage.Agents.getAllByOwnerID(userinfo.userID);
    setResponseStatus(event, 200);

    if (!result) {
        setResponseStatus(event, 500);
        return { status: "ERROR", message: "Failed to retrieve agents.", data: null };
    }

    return { status: "OK", message: "Agents retrieved successfully.", data: result.map(DBStorage.Agent.toPublic) };
});
