<script setup lang="ts">
import type { Device } from "~/utils/types";

const { status } = defineProps<{ status: Device["status"] }>();

const display = computed(() => OnlineStates[status.state]);
const tooltip = computed(() => {
	const checked = status.checked_at
		? `Checked ${formatRelative(status.checked_at)}`
		: "Not checked yet";
	return status.reason ? `${status.reason} · ${checked}` : checked;
});
</script>

<template>
	<UTooltip :text="tooltip">
		<UBadge :color="display.color" variant="soft" :icon="display.icon">
			{{ display.label }}
		</UBadge>
	</UTooltip>
</template>
