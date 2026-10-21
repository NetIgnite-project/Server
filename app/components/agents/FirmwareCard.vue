<script setup lang="ts">
/**
 * Firmware of an ESP32 agent: current version, available update, OTA progress.
 */
import type { Agent } from "~/utils/types";

const props = defineProps<{ agent: Agent }>();
const emit = defineEmits<{ refresh: [] }>();

const toast = useToast();

const catalog = await useAPILazyAsyncData("firmware-catalog-ota", async () => {
	const res = await useAPI((api) => api.getFirmware({}));
	return res.success ? res.data : null;
});

const canUpdate = computed(() => props.agent.capabilities.includes("ota"));
const online = computed(() => props.agent.state === "online");
const update = computed(() => props.agent.update);
const running = computed(
	() => !!update.value && update.value.state !== "done" && update.value.state !== "failed",
);
const probation = computed(() => props.agent.info?.ota_probation === true);
const failedVersion = computed(() => props.agent.info?.ota_failed_version as string | undefined);

const UPDATE_STATES: Record<NonNullable<Agent["update"]>["state"], string> = {
	queued: "Waiting for other agents to finish",
	starting: "Starting",
	downloading: "Downloading and installing",
	restarting: "Restarting into the new firmware",
	done: "Updated",
	failed: "Failed",
};

const otherVersion = ref<string | undefined>();
const versionItems = computed(() =>
	(catalog.data.value?.releases ?? [])
		.filter((release) => release.version !== props.agent.version)
		.map((release) => ({
			value: release.version,
			label: release.prerelease ? `${release.version} (pre-release)` : release.version,
		})),
);

const starting = ref(false);

async function startUpdate(version?: string) {
	starting.value = true;
	const res = await useAPI((api) =>
		api.postAgentsByAgentIdUpdate({ path: { agentID: props.agent.id }, body: { version } }),
	);
	starting.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't start the update", description: res.message, color: "error" });
		return;
	}
	toast.add({
		title: `Updating to ${res.data.version}`,
		description: "The agent restarts when the new firmware is installed.",
		icon: "i-lucide-download",
	});
	emit("refresh");
}

// Follow a running update closely.
let timer: ReturnType<typeof setInterval> | null = null;
watch(
	running,
	(isRunning) => {
		if (isRunning && !timer && import.meta.client) timer = setInterval(() => emit("refresh"), 2000);
		if (!isRunning && timer) {
			clearInterval(timer);
			timer = null;
		}
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});
</script>

<template>
	<DashboardSectionCard title="Firmware" description="Over-the-air updates from this server" icon="i-lucide-cpu">
		<div class="space-y-4">
			<div class="flex flex-wrap items-center gap-3">
				<span class="font-mono text-lg text-white">{{ agent.version ?? "unknown" }}</span>
				<UBadge v-if="agent.update_available && !running" color="primary" variant="soft">
					{{ agent.update_available }} available
				</UBadge>
				<UBadge v-else-if="agent.version && !running && canUpdate" color="success" variant="soft">Up to date</UBadge>
				<UBadge v-if="probation" color="warning" variant="soft">On probation</UBadge>
			</div>

			<UAlert
				v-if="failedVersion"
				color="warning"
				variant="subtle"
				icon="i-lucide-undo-2"
				:title="`The update to ${failedVersion} was rolled back`"
				description="The new firmware didn't reach the server after restarting, so the agent went back to its previous firmware."
			/>

			<UAlert
				v-if="!canUpdate"
				color="neutral"
				variant="subtle"
				icon="i-lucide-usb"
				title="This firmware can't be updated over the network"
				:description="agent.state === 'unenrolled' ? 'Set the agent up first.' : 'Install a newer firmware once with the web installer (Install tab).'"
			/>

			<!-- Running update -->
			<div v-if="update && running" class="space-y-2">
				<div class="flex items-center justify-between text-sm">
					<span class="text-slate-300">{{ UPDATE_STATES[update.state] }} · {{ update.version }}</span>
					<span v-if="update.state === 'downloading'" class="font-mono text-slate-400">{{ update.percent }}%</span>
				</div>
				<UProgress :model-value="update.state === 'downloading' ? update.percent : null" :max="100" />
			</div>

			<UAlert
				v-else-if="update?.state === 'failed'"
				color="error"
				variant="subtle"
				icon="i-lucide-circle-x"
				:title="`Update to ${update.version} failed`"
				:description="update.error ?? undefined"
			/>
			<UAlert
				v-else-if="update?.state === 'done' && update.version === agent.version"
				color="success"
				variant="subtle"
				icon="i-lucide-circle-check"
				:title="`Updated from ${update.from_version ?? 'the previous version'} to ${update.version}`"
			/>

			<!-- Start an update -->
			<div v-if="canUpdate && !running" class="flex flex-col gap-3 sm:flex-row sm:items-center">
				<UButton
					v-if="agent.update_available"
					:label="`Update to ${agent.update_available}`"
					icon="i-lucide-download"
					:loading="starting"
					:disabled="!online"
					@click="startUpdate(agent.update_available)"
				/>
				<div v-if="versionItems.length > 0" class="flex items-center gap-2">
					<USelect
						v-model="otherVersion"
						:items="versionItems"
						placeholder="Other version"
						class="w-48"
						aria-label="Firmware version"
					/>
					<UButton
						label="Install"
						color="neutral"
						variant="outline"
						:disabled="!otherVersion || !online"
						:loading="starting"
						@click="startUpdate(otherVersion)"
					/>
				</div>
			</div>
			<p v-if="canUpdate && !online && !running" class="text-xs text-slate-500">The agent has to be online to update.</p>
			<p v-if="canUpdate" class="text-xs text-slate-500">
				The agent checks the download ({{ agent.info?.signed_updates ? "signature and SHA-256" : "SHA-256" }}), restarts, and
				goes back to its previous firmware if the new one doesn't reach the server within 5 minutes.
			</p>
		</div>
	</DashboardSectionCard>
</template>
