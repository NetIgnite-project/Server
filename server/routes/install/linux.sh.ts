import { defineEventHandler, setResponseHeader } from "h3";
import { LinuxInstaller } from "../../lib/agents/linuxInstaller";
import { ConfigHandler } from "../../lib/utils/config";

// `curl -fsSL <server>/install/linux.sh | sudo sh -s -- <enrollment-token>`: installs the Linux agent.
export default defineEventHandler((event) => {
	const config = ConfigHandler.getConfig();

	setResponseHeader(event, "Content-Type", "text/x-shellscript; charset=utf-8");
	setResponseHeader(event, "Cache-Control", "no-cache");
	return LinuxInstaller.script({
		serverURL: (config?.APP_URL ?? "").replace(/\/$/, ""),
		repo: config?.LINUX_AGENT_REPO ?? "NetIgnite-project/Agent-Linux",
		version: config?.LINUX_AGENT_VERSION ?? null,
	});
});
