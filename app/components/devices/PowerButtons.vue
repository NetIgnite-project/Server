<script setup lang="ts">
import type { Device } from "~/utils/types";

const { device, size = "sm" } = defineProps<{ device: Device; size?: "sm" | "md" }>();
const emit = defineEmits<{ changed: [] }>();

const actions = useDeviceActions();

const canPower = computed(() => device.access_role !== "viewer");

async function powerOn() {
	if (await actions.powerOn(device)) emit("changed");
}

const confirm = ref<"shutdown" | "reboot" | null>(null);

async function onConfirm() {
	const action = confirm.value;
	confirm.value = null;
	if (!action) return;
	const ok = action === "shutdown" ? await actions.shutdown(device) : await actions.reboot(device);
	if (ok) emit("changed");
}
</script>

<template>
	<div v-if="canPower" class="flex items-center gap-1">
		<UTooltip :text="device.actions.power_on ? 'Power on (Wake-on-LAN)' : 'No online agent with Wake-on-LAN'">
			<UButton
				icon="i-lucide-power"
				color="success"
				variant="soft"
				:size="size"
				:disabled="!device.actions.power_on"
				:loading="actions.isBusy(device)"
				:label="size === 'md' ? 'Power on' : undefined"
				aria-label="Power on"
				@click="powerOn"
			/>
		</UTooltip>
		<UDropdownMenu
			v-if="device.actions.shutdown || device.actions.reboot"
			:items="[
				{ label: 'Shut down', icon: 'i-lucide-power-off', onSelect: () => (confirm = 'shutdown') },
				{ label: 'Reboot', icon: 'i-lucide-rotate-ccw', onSelect: () => (confirm = 'reboot') },
			]"
			:ui="{ viewport: 'main-bg-color' }"
		>
			<UButton icon="i-lucide-chevron-down" color="neutral" variant="ghost" :size="size" aria-label="More power actions" />
		</UDropdownMenu>
	</div>

	<DashboardModal
		:open="confirm !== null"
		:title="confirm === 'shutdown' ? `Shut down ${device.name}?` : `Reboot ${device.name}?`"
		description="Unsaved work on the device may be lost."
		icon="i-lucide-alert-triangle"
		icon-color="amber"
		@update:open="(open: boolean) => !open && (confirm = null)"
	>
		<template #footer>
			<UButton label="Cancel" color="neutral" variant="ghost" @click="confirm = null" />
			<UButton
				:label="confirm === 'shutdown' ? 'Shut down' : 'Reboot'"
				color="warning"
				@click="onConfirm"
			/>
		</template>
	</DashboardModal>
</template>
