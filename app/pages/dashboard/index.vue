<script setup lang="ts">
import { useUserInfoStore } from "~/composables/stores/useUserStore";
import type { Agent, Device } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Dashboard | NetIgnite",
	description: "Your devices at a glance",
});

const userInfoStore = useUserInfoStore();
const user = await userInfoStore.use();
if (!userInfoStore.isValid(user)) {
	throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
}

const devices = await useAPILazyAsyncData<Device[]>("dashboard-devices", async () => {
	const res = await useAPI((api) => api.getDevices({}));
	return res.success ? res.data : [];
});

const agents = await useAPILazyAsyncData<Agent[]>("dashboard-agents", async () => {
	const res = await useAPI((api) => api.getAgents({}));
	return res.success ? res.data : [];
});

useInterval(() => {
	devices.refresh();
	agents.refresh();
}, 20_000);

function countState(state: Device["status"]["state"]) {
	return devices.data.value?.filter((device) => device.status.state === state).length ?? 0;
}

const stats = computed(() => [
	{
		label: "Online",
		value: countState("online"),
		icon: "i-lucide-circle-check",
		iconColor: "emerald" as const,
	},
	{
		label: "Offline",
		value: countState("offline"),
		icon: "i-lucide-circle-x",
		iconColor: "error" as const,
	},
	{
		label: "Unknown",
		value: countState("unknown"),
		icon: "i-lucide-circle-help",
		iconColor: "neutral" as const,
	},
	{
		label: "Agents online",
		value: `${agents.data.value?.filter((agent) => agent.state === "online").length ?? 0} / ${agents.data.value?.length ?? 0}`,
		icon: "i-lucide-radio-tower",
		iconColor: "primary" as const,
	},
]);

const favorites = computed(() => devices.data.value?.filter((device) => device.favorite) ?? []);
const shownDevices = computed(() =>
	favorites.value.length > 0 ? favorites.value : (devices.data.value ?? []).slice(0, 8),
);
const hasNoAgentsOnline = computed(
	() =>
		(agents.data.value?.length ?? 0) > 0 &&
		!agents.data.value?.some((agent) => agent.state === "online"),
);
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader
				title="Overview"
				icon="i-lucide-layout-dashboard"
				:description="`Welcome back, ${user.display_name}`"
			>
				<template #right>
					<UButton label="Add device" icon="i-lucide-plus" to="/dashboard/devices/new" />
				</template>
			</DashboardPageHeader>
		</template>

		<template #body>
			<DashboardPageBody>
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<DashboardStatCard
						v-for="stat in stats"
						:key="stat.label"
						:label="stat.label"
						:value="stat.value"
						:loading="devices.loading.value && !devices.data.value"
						:icon="stat.icon"
						:icon-color="stat.iconColor"
					/>
				</div>

				<UAlert
					v-if="hasNoAgentsOnline"
					color="warning"
					variant="soft"
					icon="i-lucide-wifi-off"
					title="None of your agents is online"
					description="Devices can't be woken or checked until an agent connects."
					:actions="[{ label: 'View agents', to: '/dashboard/agents', color: 'warning', variant: 'outline' }]"
				/>

				<DashboardSectionCard
					:title="favorites.length > 0 ? 'Favorites' : 'Devices'"
					:description="favorites.length > 0 ? 'Your favorite devices' : 'Mark devices as favorites to pin them here'"
					icon="i-lucide-star"
					flush
				>
					<template #actions>
						<UButton label="All devices" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right" to="/dashboard/devices" />
					</template>

					<UEmpty
						v-if="!devices.loading.value && shownDevices.length === 0"
						variant="naked"
						icon="i-lucide-monitor"
						title="No devices yet"
						description="Add a device and the agent that wakes it."
						:actions="[{ label: 'Add device', icon: 'i-lucide-plus', to: '/dashboard/devices/new' }]"
						class="py-10"
					/>

					<ul v-else class="divide-y divide-slate-800">
						<li v-for="device in shownDevices" :key="device.id" class="flex items-center gap-4 px-6 py-4">
							<div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-800">
								<UIcon :name="DeviceTypes[device.type].icon" class="size-5 text-primary" />
							</div>
							<div class="min-w-0 flex-1">
								<NuxtLink :to="`/dashboard/devices/${device.id}`" class="font-medium text-white hover:underline">
									{{ device.name }}
								</NuxtLink>
								<p class="truncate text-sm text-slate-400">
									{{ DeviceTypes[device.type].label }}
									<template v-if="device.access_role !== 'owner'"> · shared by {{ device.owner.display_name }}</template>
								</p>
							</div>
							<DevicesStatusBadge :status="device.status" />
							<DevicesPowerButtons :device="device" @changed="devices.refresh()" />
						</li>
					</ul>
				</DashboardSectionCard>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>
</template>
