import type { Agent, Device } from "~/utils/types";

type BadgeColor = "success" | "error" | "warning" | "neutral" | "primary" | "info";

export const DeviceTypes: Record<Device["type"], { label: string; icon: string }> = {
	server: { label: "Server", icon: "i-lucide-server" },
	desktop: { label: "Desktop PC", icon: "i-lucide-monitor" },
	laptop: { label: "Laptop", icon: "i-lucide-laptop" },
	printer: { label: "Printer", icon: "i-lucide-printer" },
	nas: { label: "NAS", icon: "i-lucide-hard-drive" },
	other: { label: "Other", icon: "i-lucide-box" },
};

export const OnlineStates: Record<
	Device["status"]["state"],
	{ label: string; color: BadgeColor; icon: string }
> = {
	online: { label: "Online", color: "success", icon: "i-lucide-circle-check" },
	offline: { label: "Offline", color: "error", icon: "i-lucide-circle-x" },
	unknown: { label: "Unknown", color: "neutral", icon: "i-lucide-circle-help" },
};

export const StatusMethods: Record<
	Device["status_method"],
	{ label: string; description: string }
> = {
	none: { label: "Off", description: "Don't check whether the device is online." },
	link_local: {
		label: "MAC (IPv6 link-local)",
		description:
			"The agent pings the IPv6 address derived from the MAC address. Doesn't work with Windows and many Linux defaults.",
	},
	ipv4: { label: "IPv4 address", description: "The agent pings the device's IPv4 address." },
	ipv6: { label: "IPv6 address", description: "The agent pings the device's IPv6 address." },
	ssh: {
		label: "SSH port",
		description:
			"The agent checks whether the SSH port (22, or the port below) accepts connections. With an SSH login (SSH tab), it can also shut the device down and reboot it.",
	},
	host_agent: {
		label: "Linux agent on the device",
		description: "The device is online while the NetIgnite Linux agent running on it is connected.",
	},
};

export const AccessRoles: Record<
	Device["access_role"],
	{ label: string; color: BadgeColor; description: string }
> = {
	owner: { label: "Owner", color: "primary", description: "Full control, sharing and deletion." },
	manager: { label: "Manager", color: "info", description: "Power actions and editing the device." },
	operator: { label: "Operator", color: "warning", description: "Power on, shut down and reboot." },
	viewer: { label: "Viewer", color: "neutral", description: "Sees the device and its status." },
};

export const AgentKinds: Record<Agent["kind"], { label: string; icon: string }> = {
	esp32: { label: "ESP32", icon: "i-lucide-cpu" },
	linux: { label: "Linux agent", icon: "i-lucide-terminal" },
};

export const AgentStates: Record<Agent["state"], { label: string; color: BadgeColor }> = {
	online: { label: "Online", color: "success" },
	offline: { label: "Offline", color: "error" },
	unenrolled: { label: "Not set up", color: "warning" },
};

/** "2 minutes ago" style, or "never". */
export function formatRelative(ts: number | null | undefined) {
	if (!ts) return "never";
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 10) return "just now";
	if (seconds < 60) return `${seconds} seconds ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	return formatDate(ts);
}

/** Runs `callback` every `ms` while the calling component is mounted. */
export function useInterval(callback: () => void, ms: number) {
	let timer: ReturnType<typeof setInterval> | null = null;
	onMounted(() => {
		timer = setInterval(callback, ms);
	});
	onBeforeUnmount(() => {
		if (timer) clearInterval(timer);
	});
}
