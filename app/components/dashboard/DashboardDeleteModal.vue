<script setup lang="ts">
const props = withDefaults(
	defineProps<{
		title: string;
		warningText: string;
		preventAutoClose?: boolean;
		onDelete: () => Promise<void> | void;
	}>(),
	{
		preventAutoClose: false,
	},
);

const open = defineModel<boolean>("open", { required: true });

const confirmText = ref("");
const loading = ref(false);

// Reset the confirmation text whenever the modal closes.
watch(open, (value) => {
	if (!value) confirmText.value = "";
});

async function onDeleteWrapper() {
	loading.value = true;
	try {
		await props.onDelete();
		if (!props.preventAutoClose) {
			open.value = false;
		}
	} catch (error) {
		// The caller shows the error toast; just keep the modal open.
		console.error("Delete operation failed:", error);
	} finally {
		loading.value = false;
	}
}
</script>

<template>
	<DashboardModal
		v-model:open="open"
		:title="title"
		description="This action is permanent"
		icon="i-lucide-alert-triangle"
		icon-color="error"
	>
		<div class="space-y-4">
			<div class="rounded-lg border border-red-900/50 bg-red-950/50 p-4">
				<p class="text-sm text-red-300">
					<strong>Warning:</strong>
					{{ warningText }}
				</p>
			</div>

			<UFormField>
				<template #label>
					Type <span class="text-red-400">DELETE</span> to confirm
				</template>
				<UInput v-model="confirmText" placeholder="Type DELETE" class="w-full" autocomplete="off" />
			</UFormField>
		</div>

		<template #footer>
			<div class="flex justify-end gap-3">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
				<UButton
					:label="title"
					color="error"
					:loading="loading"
					:disabled="confirmText !== 'DELETE'"
					icon="i-lucide-trash-2"
					@click="onDeleteWrapper"
				/>
			</div>
		</template>
	</DashboardModal>
</template>
