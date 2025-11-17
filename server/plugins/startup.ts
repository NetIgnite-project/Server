import { AgentControlService } from "../agent-control-service";
import { ConfigHandler } from "../utils/config";
import { DBStorage } from "../db";
import { Logger } from "../utils/logger";
import { SessionHandler } from "../utils/auth/sessions";
import crypto from 'crypto';
import { AuthHandler } from "../utils/auth/handler";

async function createAdminUserIfNoneExists() {

    const allUsers = await DBStorage.Users.getAll();

    const randomAdminPassword = crypto.randomBytes(32).toString('hex');

    if (!allUsers) {
        Logger.error("Error retrieving users from DB");
        process.exit(1);
    }

    if (allUsers.length === 0) {
        const defaultAdmin = await DBStorage.Users.insert({
            username: 'admin',
            password_hash: await AuthHandler.hashPassword(randomAdminPassword),
            role: 'admin',
            favorites: []
        });
        if (!defaultAdmin) {
            Logger.error("Error creating default admin user");
            process.exit(1);
        }
    }
}

export default defineNitroPlugin(async () => {

	const config = await ConfigHandler.loadConfig();
    if (!config) {
        Logger.error("Error getting config");
        process.exit(1);
    }
	Logger.log('Config loaded');

    if (config.logLevel) {
        Logger.setLogLevel(config.logLevel);
    }

    if (AgentControlService.isInitialized()) return;

    await DBStorage.init();
    console.log('DB initialized');

    await createAdminUserIfNoneExists();
    console.log('Admin user check complete');

    await SessionHandler.init();
    console.log('Session handler initialized');

    const agents = await DBStorage.Agents.getAll();

    if (!agents) {
        Logger.error("Error getting agents from DB");
        process.exit(1);
    }

    await AgentControlService.init({ ...config, agents });
    console.log('Control service initialized');

});

