<script setup lang="ts">
/**
 * Live log and remote control of an ESP32 agent: log level, restart, settings stored on the
 * device (server address, host name, IP), factory reset. The log streams over `/ws/console`.
 */
import type { PutAgentsByAgentIdDeviceConfigData } from "~/api-client";
import type { Agent, NewAgent } from "~/utils/types";

type DeviceConfig = NonNullable<PutAgentsByAgentIdDeviceConfigData["body"]>;

const injected = useSubrouterInjectedData<Agent, NewAgent>("agent", true).inject();
if (injected.isNew) await navigateTo("/dashboard/agents/new");
const agent = computed(() => injected.data.value as Agent);

const toast = useToast();
const { appUrl } = useRuntimeAppConfigs();

const has = (capability: string) => agent.value.capabilities.includes(capability);

// --- Live log ------------------------------------------------------------------------------------

const MAX_LINES = 2000;
const lines = ref<string[]>([]);
const connection = ref<"connecting" | "online" | "offline" | "closed">("connecting");
const consoleError = ref<string | null>(null);
const level = ref<"error" | "warn" | "info" | "debug">("info");
const follow = ref(true);
const logBox = useTemplateRef<HTMLElement>("logBox");

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByPage = false;

function append(newLines: string[], reset: boolean) {
	lines.value = (reset ? newLines : [...lines.value, ...newLines]).slice(-MAX_LINES);
	if (follow.value) {
		nextTick(() => {
			if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
		});
	}
}

function connect() {
	const token = useAppCookies().sessionToken.get().value;
	if (!token) return;

	connection.value = "connecting";
	consoleError.value = null;
	socket = new WebSocket(`${appUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws/console`);

	socket.onopen = () => {
		socket?.send(JSON.stringify({ type: "auth", token, agent_id: agent.value.id }));
	};
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		switch (message.type) {
			case "ready":
			case "state":
				connection.value = message.online ? "online" : "offline";
				if (message.type === "state")
					append([message.online ? "— agent connected —" : "— agent disconnected —"], false);
				break;
			case "lines":
				if (message.level) level.value = message.level;
				append(
					[...(message.dropped ? [`… ${message.dropped} lines skipped …`] : []), ...message.lines],
					message.reset,
				);
				break;
			case "error":
				consoleError.value = message.message;
				break;
		}
	};
	socket.onclose = () => {
		connection.value = "closed";
		socket = null;
		// Reconnect after network hiccups (the server checks the session again).
		if (!closedByPage && !consoleError.value) reconnectTimer = setTimeout(connect, 5000);
	};
}

onMounted(connect);
onBeforeUnmount(() => {
	closedByPage = true;
	if (reconnectTimer) clearTimeout(reconnectTimer);
	socket?.close();
});

async function copyLog() {
	try {
		await navigator.clipboard.writeText(lines.value.join("\n"));
		toast.add({ title: "Log copied", icon: "i-lucide-clipboard-check", color: "success" });
	} catch {
		toast.add({ title: "Copy failed", color: "warning" });
	}
}

// --- Settings on the device ----------------------------------------------------------------------

const levelItems = [
	{ value: "error", label: "Errors" },
	{ value: "warn", label: "Warnings" },
	{ value: "info", label: "Info" },
	{ value: "debug", label: "Debug" },
];

async function sendConfig(body: DeviceConfig, success: string) {
	const res = await useAPI((api) =>
		api.putAgentsByAgentIdDeviceConfig({ path: { agentID: agent.value.id }, body }),
	);
	if (!res.success) {
		toast.add({
			title: "The agent didn't accept the change",
			description: res.message,
			color: "error",
		});
		return false;
	}
	toast.add({ title: success, color: "success", icon: "i-lucide-check" });
	return true;
}

async function setLevel(value: "error" | "warn" | "info" | "debug") {
	if (await sendConfig({ log_level: value }, `Log level: ${value}`)) level.value = value;
}

const settingsForm = reactive({
	server_url: "",
	name: (agent.value.info?.name as string | undefined) ?? "",
	ipMode: (agent.value.info?.ip_mode as "dhcp" | "static" | undefined) ?? "dhcp",
	address: "",
	gateway: "",
	netmask: "255.255.255.0",
	dns1: "",
});
const savingSettings = ref(false);

async function saveSettings() {
	const body: DeviceConfig = {};
	if (settingsForm.server_url.trim()) body.server_url = settingsForm.server_url.trim();
	if (settingsForm.name.trim() && settingsForm.name.trim() !== agent.value.info?.name)
		body.name = settingsForm.name.trim();
	if (settingsForm.ipMode === "dhcp" && agent.value.info?.ip_mode === "static")
		body.ip = { mode: "dhcp" };
	if (settingsForm.ipMode === "static") {
		body.ip = {
			mode: "static",
			address: settingsForm.address.trim(),
			gateway: settingsForm.gateway.trim(),
			netmask: settingsForm.netmask.trim(),
			...(settingsForm.dns1.trim() ? { dns1: settingsForm.dns1.trim() } : {}),
		};
	}
	if (Object.keys(body).length === 0) {
		toast.add({ title: "Nothing changed", color: "neutral" });
		return;
	}

	savingSettings.value = true;
	const ok = await sendConfig(
		body,
		body.server_url || body.ip
			? "The agent is trying the new settings"
			: "Settings saved on the agent",
	);
	savingSettings.value = false;
	if (ok) settingsForm.server_url = "";
}

// --- Restart and reset ---------------------------------------------------------------------------

const restarting = ref(false);
const resetOpen = ref(false);

async function restart() {
	restarting.value = true;
	const res = await useAPI((api) =>
		api.postAgentsByAgentIdReboot({ path: { agentID: agent.value.id } }),
	);
	restarting.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't restart the agent", description: res.message, color: "error" });
		return;
	}
	toast.add({ title: "The agent restarts", icon: "i-lucide-rotate-ccw" });
}

async function factoryReset() {
	const res = await useAPI((api) =>
		api.postAgentsByAgentIdFactoryReset({ path: { agentID: agent.value.id } }),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't reset the agent", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({
		title: "The agent was reset",
		description: "Set it up again with the web installer.",
	});
	await injected.refresh?.();
	await navigateTo(`/dashboard/agents/${agent.value.id}/install`);
}

const CONNECTION_STATES = {
	connecting: { label: "Connecting", color: "neutral" },
	online: { label: "Live", color: "success" },
	offline: { label: "Agent offline", color: "warning" },
	closed: { label: "Disconnected", color: "error" },
} as const;
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-4xl">
		<DashboardSectionCard title="Log" description="Live output of the agent" icon="i-lucide-scroll-text" flush>
			<template #actions>
				<UBadge :color="CONNECTION_STATES[connection].color" variant="soft">{{ CONNECTION_STATES[connection].label }}</UBadge>
			</template>

			<div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-3">
				<USelect
					:model-value="level"
					:items="levelItems"
					:disabled="connection !== 'online' || !has('config')"
					class="w-40"
					aria-label="Log level"
					@update:model-value="setLevel"
				/>
				<USwitch v-model="follow" label="Follow" />
				<div class="flex-1" />
				<UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="sm" label="Copy" @click="copyLog" />
				<UButton icon="i-lucide-eraser" color="neutral" variant="ghost" size="sm" label="Clear" @click="lines = []" />
			</div>

			<UAlert v-if="consoleError" color="error" variant="subtle" icon="i-lucide-circle-x" :title="consoleError" class="m-4" />
			<div
				ref="logBox"
				class="h-[28rem] overflow-y-auto bg-slate-950 px-4 py-3 font-mono text-xs leading-relaxed text-slate-300"
				role="log"
				aria-live="polite"
			>
				<p v-if="lines.length === 0" class="text-slate-500">
					{{ connection === "online" ? "No log lines yet." : "The log appears here when the agent is online." }}
				</p>
				<div v-for="(line, index) in lines" :key="index" class="whitespace-pre-wrap break-all" :class="{
					'text-red-400': / E /.test(line.slice(0, 14)),
					'text-amber-300': / W /.test(line.slice(0, 14)),
					'text-slate-500': / D /.test(line.slice(0, 14)) || line.startsWith('—') || line.startsWith('…'),
				}">{{ line }}</div>
			</div>
		</DashboardSectionCard>

		<DashboardSectionCard
			title="Settings on the agent"
			description="Changes are sent to the agent; Wi-Fi is changed over USB (Install tab)"
			icon="i-lucide-sliders-horizontal"
		>
			<form class="space-y-5" @submit.prevent="saveSettings">
				<UFormField
					label="Server address"
					description="Leave empty to keep it. The agent keeps a new address only if it reaches this server with it within 2 minutes."
				>
					<UInput v-model="settingsForm.server_url" placeholder="https://netignite.example.com" class="w-full" />
				</UFormField>
				<UFormField label="Host name" description="Letters, digits and -. Used after the next restart.">
					<UInput v-model="settingsForm.name" class="w-full sm:w-80" />
				</UFormField>
				<UFormField label="IP address" description="A static address is also only kept if the agent reaches the server with it.">
					<URadioGroup
						v-model="settingsForm.ipMode"
						orientation="horizontal"
						:items="[
							{ value: 'dhcp', label: 'Automatic (DHCP)' },
							{ value: 'static', label: 'Static' },
						]"
					/>
				</UFormField>
				<div v-if="settingsForm.ipMode === 'static'" class="grid gap-4 sm:grid-cols-2">
					<UFormField label="Address" required><UInput v-model="settingsForm.address" placeholder="192.168.1.50" class="w-full" /></UFormField>
					<UFormField label="Gateway" required><UInput v-model="settingsForm.gateway" placeholder="192.168.1.1" class="w-full" /></UFormField>
					<UFormField label="Netmask" required><UInput v-model="settingsForm.netmask" class="w-full" /></UFormField>
					<UFormField label="DNS server"><UInput v-model="settingsForm.dns1" placeholder="Gateway" class="w-full" /></UFormField>
				</div>
				<div class="flex justify-end">
					<UButton
						type="submit"
						label="Send to agent"
						icon="i-lucide-send"
						:loading="savingSettings"
						:disabled="agent.state !== 'online' || !has('config')"
					/>
				</div>
			</form>
		</DashboardSectionCard>

		<DashboardSectionCard title="Device" description="Restart or reset the agent" icon="i-lucide-power" tone="danger">
			<div class="space-y-6">
				<div class="flex flex-col gap-4 md:flex-row md:items-center">
					<div class="flex-1">
						<h4 class="font-medium text-white">Restart</h4>
						<p class="mt-1 text-sm text-slate-400">
							The agent is back online after a few seconds; until then its devices can't be woken or checked.
						</p>
					</div>
					<UButton
						label="Restart"
						color="neutral"
						variant="outline"
						icon="i-lucide-rotate-ccw"
						:loading="restarting"
						:disabled="agent.state !== 'online' || !has('device.reboot')"
						@click="restart"
					/>
				</div>
				<div class="flex flex-col gap-4 md:flex-row md:items-center">
					<div class="flex-1">
						<h4 class="font-medium text-white">Factory reset</h4>
						<p class="mt-1 text-sm text-slate-400">
							Erases Wi-Fi, server and credential on the agent. Set it up again with the web installer.
						</p>
					</div>
					<UButton
						label="Factory reset"
						color="error"
						variant="soft"
						icon="i-lucide-eraser"
						:disabled="agent.state !== 'online' || !has('device.reset')"
						@click="resetOpen = true"
					/>
				</div>
			</div>
		</DashboardSectionCard>

		<DashboardDeleteModal
			v-model:open="resetOpen"
			title="Factory Reset"
			warning-text="The agent forgets its Wi-Fi and credential and goes offline until it is set up again over USB."
			:on-delete="factoryReset"
		/>
	</div>
</template>
