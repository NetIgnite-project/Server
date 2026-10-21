<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { Device } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Devices | NetIgnite",
	description: "Your devices and devices shared with you",
});

const toast = useToast();
const actions = useDeviceActions();

const columns: TableColumn<Device>[] = [
	{ id: "favorite", header: "" },
	{ accessorKey: "name", header: "Name" },
	{ accessorKey: "type", header: "Type" },
	{ id: "state", accessorFn: (device) => device.status.state, header: "Status" },
	{ accessorKey: "access_role", header: "Access" },
	{ id: "actions", header: "" },
];

const devices = await useAPIAsyncData<Device[]>("devices", async () => {
	const res = await useAPI((api) => api.getDevices({}));
	if (!res.success) {
		toast.add({ title: "Failed to load devices", description: res.message, color: "error" });
		return [];
	}
	return res.data;
});

useInterval(() => devices.refresh(), 20_000);

const typeOptions = Object.entries(DeviceTypes).map(([value, type]) => ({
	label: type.label,
	value,
}));
const stateOptions = Object.entries(OnlineStates).map(([value, state]) => ({
	label: state.label,
	value,
}));

async function toggleFavorite(device: Device) {
	if (await actions.setFavorite(device, !device.favorite)) await devices.refresh();
}
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader title="Devices" icon="i-lucide-monitor" description="Power on and check your devices" />
		</template>

		<template #body>
			<DashboardPageBody>
				<DashboardDataTable
					:data="devices.data"
					:columns="columns"
					:loading="devices.loading"
					:filters="[
						{ column: 'name', type: 'text', placeholder: 'Search devices...', icon: 'i-lucide-search' },
						{ column: 'state', type: 'select', placeholder: 'All statuses', options: stateOptions },
						{ column: 'type', type: 'select', placeholder: 'All types', options: typeOptions },
					]"
					empty-title="No devices"
					empty-description="Add a device to wake it from anywhere."
					empty-icon="i-lucide-monitor"
					@refresh="devices.refresh()"
				>
					<template #header-right>
						<UButton label="Add device" icon="i-lucide-plus" to="/dashboard/devices/new" />
					</template>

					<template #favorite-cell="{ row }">
						<UButton
							:icon="row.original.favorite ? 'i-lucide-star' : 'i-lucide-star-off'"
							:color="row.original.favorite ? 'warning' : 'neutral'"
							variant="ghost"
							size="sm"
							:aria-label="row.original.favorite ? 'Remove from favorites' : 'Add to favorites'"
							@click="toggleFavorite(row.original)"
						/>
					</template>

					<template #name-cell="{ row }">
						<NuxtLink :to="`/dashboard/devices/${row.original.id}`" class="font-medium text-primary hover:underline">
							{{ row.original.name }}
						</NuxtLink>
						<p v-if="row.original.description" class="line-clamp-1 max-w-xs text-sm text-slate-400">
							{{ row.original.description }}
						</p>
					</template>

					<template #type-cell="{ row }">
						<span class="inline-flex items-center gap-2 text-sm">
							<UIcon :name="DeviceTypes[row.original.type].icon" class="size-4 text-slate-400" />
							{{ DeviceTypes[row.original.type].label }}
						</span>
					</template>

					<template #state-cell="{ row }">
						<DevicesStatusBadge :status="row.original.status" />
					</template>

					<template #access_role-cell="{ row }">
						<UBadge :color="AccessRoles[row.original.access_role].color" variant="subtle" size="sm">
							{{ AccessRoles[row.original.access_role].label }}
						</UBadge>
						<p v-if="row.original.access_role !== 'owner'" class="text-xs text-slate-500">
							by {{ row.original.owner.display_name }}
						</p>
					</template>

					<template #actions-cell="{ row }">
						<DevicesPowerButtons :device="row.original" @changed="devices.refresh()" />
					</template>

					<template #empty-actions>
						<UButton label="Add device" color="primary" to="/dashboard/devices/new" />
					</template>
				</DashboardDataTable>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>
</template>
