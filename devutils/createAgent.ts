import { DBStorage } from '../server/db';
import { AgentSecrets } from '../server/utils/auth/agentSecrets';

await DBStorage.init();

const secret = "123456";

const agent: DBStorage.Agent.ModelWithoutID = {
    name: "Test Agent",
    type: "microcontroller",
    description: "This is a test agent",
    secretHash: AgentSecrets.hash(secret),
    ownerID: 1
}

const id = await DBStorage.Agents.insert(agent);
console.log(`Created test agent ${id} with secret '${secret}'. Restart the server to load it.`);
