import { defineEventHandler, setResponseHeader } from "h3";
import { AgentInstaller } from "../../lib/agents/agentInstaller";
import { ConfigHandler } from "../../lib/utils/config";

// In an elevated PowerShell: `& ([scriptblock]::Create((irm <server>/install/windows.ps1))) <token>`.
export default defineEventHandler((event) => {
	setResponseHeader(event, "Content-Type", "text/plain; charset=utf-8");
	setResponseHeader(event, "Cache-Control", "no-cache");
	return AgentInstaller.windows(AgentInstaller.optionsFrom(ConfigHandler.getConfig()));
});
