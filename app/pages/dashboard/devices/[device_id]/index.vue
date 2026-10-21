<script setup lang="ts">
import { zPostDevicesBody } from "~/api-client/zod.gen";
import { useUserInfoStore } from "~/composables/stores/useUserStore";
import type { Agent, Device, NewDevice } from "~/utils/types";

const toast = useToast();
const actions = useDeviceActions();

const device = useSubrouterInjectedData<Device, NewDevice>("device", true).inject();

const isOwner = device.isNew || device.data.value.access_role === "owner";
const canEdit = device.isNew || ["owner", "manager"].includes(device.data.value.access_role);

function toFormState(source: NewDevice | Device): NewDevice {
	return {
		name: source.name,
		type: source.type,
		description: source.description ?? "",
		mac_address: source.mac_address,
		wol_port: source.wol_port ?? 9,
		agent_id: source.agent_id ?? null,
		status_method: source.status_method ?? "none",
		status_address: source.status_address ?? null,
		status_tcp_port: source.status_tcp_port ?? null,
		host_agent_id: source.host_agent_id ?? null,
	};
}

const formState = ref<NewDevice>(toFormState(device.data.value));

// Referenced here (not only in the template) so Biome keeps it a value import.
const formSchema = zPostDevicesBody;

// Agents are never shared, so only the owner can pick them.
const agents = await useAPILazyAsyncData<Agent[]>("device-form-agents", async () => {
	if (!isOwner) return [];
	const res = await useAPI((api) => api.getAgents({}));
	return res.success ? res.data : [];
});

const wolAgentOptions = computed(() => [
	{ label: "No agent", value: null },
	...(agents.data.value ?? []).map((agent) => ({
		label: `${agent.name} (${AgentKinds[agent.kind].label})`,
		value: agent.id,
	})),
]);
const hostAgentOptions = computed(() => [
	{ label: "None", value: null },
	...(agents.data.value ?? [])
		.filter((agent) => agent.kind === "linux")
		.map((agent) => ({ label: agent.name, value: agent.id })),
]);

const typeOptions = Object.entries(DeviceTypes).map(([value, type]) => ({
	label: type.label,
	value,
	icon: type.icon,
}));
const statusMethodOptions = Object.entries(StatusMethods).map(([value, method]) => ({
	label: method.label,
	value,
}));

const needsAddress = computed(() =>
	["ipv4", "ipv6", "ssh"].includes(formState.value.status_method ?? "none"),
);
const addressPlaceholder = computed(() =>
	formState.value.status_method === "ipv4"
		? "192.168.1.20"
		: formState.value.status_method === "ipv6"
			? "fd00::20"
			: "nas.local or 192.168.1.20",
);

const saving = ref(false);

async function onSubmit() {
	saving.value = true;
	const body: NewDevice = {
		...formState.value,
		status_address: needsAddress.value ? formState.value.status_address || null : null,
	};

	const res = device.isNew
		? await useAPI((api) => api.postDevices({ body }))
		: await useAPI((api) =>
				api.putDevicesByDeviceId({
					path: { deviceID: device.data.value.id },
					// Managers can't change the agents; don't send them.
					body: isOwner ? body : { ...body, agent_id: undefined, host_agent_id: undefined },
				}),
			);
	saving.value = false;

	if (!res.success) {
		toast.add({
			title: "Couldn't save the device",
			description: res.message,
			color: "error",
			icon: "i-lucide-alert-circle",
		});
		return;
	}

	toast.add({
		title: device.isNew ? "Device added" : "Device saved",
		color: "success",
		icon: "i-lucide-check",
	});
	if (device.isNew) {
		await navigateTo(`/dashboard/devices/${res.data.id}`);
	} else {
		await device.refresh();
	}
}

const checking = ref(false);

async function checkNow() {
	if (device.isNew) return;
	checking.value = true;
	await actions.refreshStatus(device.data.value);
	await device.refresh();
	checking.value = false;
}

async function toggleFavorite() {
	if (device.isNew) return;
	if (await actions.setFavorite(device.data.value, !device.data.value.favorite))
		await device.refresh();
}

const deleteOpen = ref(false);

async function onDelete() {
	if (device.isNew) return;
	const res = await useAPI((api) =>
		api.deleteDevicesByDeviceId({ path: { deviceID: device.data.value.id } }),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't delete the device", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({ title: "Device deleted", color: "success" });
	await navigateTo("/dashboard/devices");
}

async function leaveDevice() {
	if (device.isNew) return;
	const user = await useUserInfoStore().use();
	const res = await useAPI((api) =>
		api.deleteDevicesByDeviceIdSharesByUserId({
			path: { deviceID: device.data.value.id, userID: user.value.id },
		}),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't leave the device", description: res.message, color: "error" });
		return;
	}
	toast.add({ title: "You no longer have access to this device", color: "success" });
	await navigateTo("/dashboard/devices");
}
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<template v-if="!device.isNew">
			<DashboardSectionCard title="Status" description="Power and online status" icon="i-lucide-activity">
				<template #actions>
					<UButton
						:icon="device.data.value.favorite ? 'i-lucide-star' : 'i-lucide-star-off'"
						:color="device.data.value.favorite ? 'warning' : 'neutral'"
						variant="ghost"
						:label="device.data.value.favorite ? 'Favorite' : 'Add to favorites'"
						@click="toggleFavorite"
					/>
				</template>

				<div class="flex flex-wrap items-center justify-between gap-4">
					<div class="flex items-center gap-3">
						<DevicesStatusBadge :status="device.data.value.status" />
						<UButton
							label="Check now"
							icon="i-lucide-refresh-cw"
							color="neutral"
							variant="ghost"
							size="sm"
							:loading="checking"
							:disabled="device.data.value.status_method === 'none'"
							@click="checkNow"
						/>
					</div>
					<DevicesPowerButtons :device="device.data.value" size="md" @changed="device.refresh()" />
				</div>

				<p v-if="device.data.value.access_role !== 'owner'" class="mt-4 text-sm text-slate-400">
					Shared with you by {{ device.data.value.owner.display_name }} as
					<strong>{{ AccessRoles[device.data.value.access_role].label }}</strong>:
					{{ AccessRoles[device.data.value.access_role].description }}
				</p>
			</DashboardSectionCard>
		</template>

		<div v-else>
			<h2 class="text-xl font-semibold text-white">Add a device</h2>
			<p class="mt-1 text-sm text-slate-400">
				Enter the device's MAC address and pick the agent in the same network that wakes it.
			</p>
		</div>

		<DashboardSectionCard
			title="Settings"
			:description="canEdit ? 'Name, Wake-on-LAN and status check' : 'Only the owner and managers can change these'"
			icon="i-lucide-settings"
		>
			<UForm
				:schema="formSchema"
				:state="formState"
				:disabled="!canEdit"
				class="divide-y divide-slate-800"
				@submit="onSubmit"
			>
				<UFormField name="name" label="Name" required class="flex items-start justify-between gap-4 py-4 first:pt-0 max-sm:flex-col" :ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }">
					<UInput v-model="formState.name" placeholder="Gaming PC" class="w-full" />
				</UFormField>

				<UFormField name="type" label="Type" class="flex items-start justify-between gap-4 py-4 max-sm:flex-col" :ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }">
					<USelect v-model="formState.type" :items="typeOptions" class="w-full" />
				</UFormField>

				<UFormField name="description" label="Description" class="flex items-start justify-between gap-4 py-4 max-sm:flex-col" :ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }">
					<UTextarea v-model="formState.description" :rows="2" autoresize placeholder="Optional" class="w-full" />
				</UFormField>

				<UFormField
					name="mac_address"
					label="MAC address"
					description="Of the device's wired network card, e.g. AA:BB:CC:DD:EE:FF."
					required
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<UInput v-model="formState.mac_address" placeholder="AA:BB:CC:DD:EE:FF" class="w-full font-mono" />
				</UFormField>

				<UFormField
					name="wol_port"
					label="Wake-on-LAN port"
					description="UDP port of the magic packet; 9 unless the device expects 7."
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<UInputNumber v-model="formState.wol_port" :min="1" :max="65535" class="w-full" />
				</UFormField>

				<UFormField
					name="agent_id"
					label="Agent"
					:description="isOwner ? 'The agent in the same network that sends the magic packet.' : 'Chosen by the owner.'"
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<USelect v-if="isOwner" v-model="formState.agent_id" :items="wolAgentOptions" class="w-full" />
					<UInput v-else :model-value="device.isNew ? '' : (device.data.value.agent?.name ?? 'None')" disabled class="w-full" />
				</UFormField>

				<UFormField
					name="status_method"
					label="Status check"
					:description="StatusMethods[formState.status_method ?? 'none'].description"
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<USelect v-model="formState.status_method" :items="statusMethodOptions" class="w-full" />
				</UFormField>

				<UFormField
					v-if="needsAddress"
					name="status_address"
					label="Address"
					description="Checked by the device's agent, so it must be reachable from the agent's network."
					required
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<UInput v-model="formState.status_address" :placeholder="addressPlaceholder" class="w-full font-mono" />
				</UFormField>

				<UFormField
					v-if="['link_local', 'ipv4', 'ipv6', 'ssh'].includes(formState.status_method ?? 'none')"
					name="status_tcp_port"
					label="TCP port"
					:description="formState.status_method === 'ssh' ? 'Defaults to 22.' : 'Optional: also counts the device as online when this port accepts connections (e.g. 445, 3389).'"
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<UInputNumber v-model="formState.status_tcp_port" :min="1" :max="65535" placeholder="None" class="w-full" />
				</UFormField>

				<UFormField
					name="host_agent_id"
					label="Linux agent on the device"
					description="Reports the device's status and enables shut down and reboot."
					class="flex items-start justify-between gap-4 py-4 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }"
				>
					<USelect v-if="isOwner" v-model="formState.host_agent_id" :items="hostAgentOptions" class="w-full" />
					<UInput v-else :model-value="device.isNew ? '' : (device.data.value.host_agent?.name ?? 'None')" disabled class="w-full" />
				</UFormField>

				<div v-if="canEdit" class="flex justify-end pt-4">
					<UButton type="submit" :label="device.isNew ? 'Add device' : 'Save'" icon="i-lucide-save" :loading="saving" />
				</div>
			</UForm>
		</DashboardSectionCard>

		<DashboardSectionCard
			v-if="!device.isNew && isOwner"
			title="Danger Zone"
			description="Irreversible actions"
			icon="i-lucide-alert-triangle"
			tone="danger"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<div class="flex-1">
					<h4 class="font-medium text-white">Delete device</h4>
					<p class="mt-1 text-sm text-slate-400">Removes the device and all its shares.</p>
				</div>
				<UButton label="Delete device" color="error" variant="soft" icon="i-lucide-trash-2" @click="deleteOpen = true" />
			</div>
		</DashboardSectionCard>

		<DashboardSectionCard
			v-if="!device.isNew && !isOwner"
			title="Leave device"
			description="Remove this shared device from your account"
			icon="i-lucide-log-out"
			tone="danger"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<p class="flex-1 text-sm text-slate-400">You lose access until the owner shares it with you again.</p>
				<UButton label="Leave" color="error" variant="soft" icon="i-lucide-log-out" @click="leaveDevice" />
			</div>
		</DashboardSectionCard>
	</div>

	<DashboardDeleteModal
		v-if="!device.isNew"
		v-model:open="deleteOpen"
		title="Delete Device"
		warning-text="The device and its shares are removed. This can't be undone."
		:on-delete="onDelete"
	/>
</template>
