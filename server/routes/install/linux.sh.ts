import { defineEventHandler, setResponseHeader } from "h3";
import { AgentInstaller } from "../../lib/agents/agentInstaller";
import { ConfigHandler } from "../../lib/utils/config";

// `curl -fsSL <server>/install/linux.sh | sudo sh -s -- <enrollment-token>`: installs the agent on Linux.
export default defineEventHandler((event) => {
	setResponseHeader(event, "Content-Type", "text/x-shellscript; charset=utf-8");
	setResponseHeader(event, "Cache-Control", "no-cache");
	return AgentInstaller.linux(AgentInstaller.optionsFrom(ConfigHandler.getConfig()));
});
