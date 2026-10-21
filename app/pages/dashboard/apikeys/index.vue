<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { APIKey } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "API Keys | NetIgnite",
	description: "Manage your API keys",
});

const toast = useToast();

const columns: TableColumn<APIKey>[] = [
	{ accessorKey: "id", header: "ID" },
	{ accessorKey: "description", header: "Description" },
	{ accessorKey: "created_at", header: "Created At" },
	{ accessorKey: "expires_at", header: "Expires At" },
	{ id: "status", header: "Status" },
	{ id: "actions", header: "" },
];

const apiKeys = await useAPIAsyncData<APIKey[]>("account-apikeys", async () => {
	const res = await useAPI((api) => api.getAccountApikeys({}));
	if (!res.success) {
		toast.add({ title: "Failed to load API keys", description: res.message, color: "error" });
		return [];
	}
	return res.data;
});

function isExpired(key: APIKey) {
	return key.expires_at !== null && key.expires_at < Date.now();
}

const deleteConfirmOpen = ref(false);
const deleteTargetId = ref<string | null>(null);

function openDelete(key: APIKey) {
	deleteTargetId.value = key.id;
	deleteConfirmOpen.value = true;
}

async function onDeleteApiKey() {
	const apiKeyID = deleteTargetId.value;
	if (!apiKeyID) return;

	const res = await useAPI((api) => api.deleteAccountApikeysByApiKeyId({ path: { apiKeyID } }));
	if (!res.success) {
		toast.add({
			title: "Failed to delete API key",
			description: res.message,
			icon: "i-lucide-alert-circle",
			color: "error",
		});
		throw new Error(res.message);
	}

	toast.add({ title: "API key deleted", color: "success" });
	await apiKeys.refresh();
}
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader title="API Keys" icon="i-lucide-key" description="Manage your API keys" />
		</template>

		<template #body>
			<DashboardPageBody>
				<DashboardDataTable
					:data="apiKeys.data"
					:columns="columns"
					:loading="apiKeys.loading"
					:filters="[
						{
							column: 'description',
							type: 'text',
							placeholder: 'Search description...',
							icon: 'i-lucide-search',
						},
					]"
					empty-title="No API keys"
					empty-description="Create your first API key to get started."
					empty-icon="i-lucide-key"
					@refresh="apiKeys.refresh()"
				>
					<template #header-right>
						<UButton label="New API Key" icon="i-lucide-plus" color="primary" to="/dashboard/apikeys/new" />
					</template>

					<template #id-cell="{ row }">
						<NuxtLink
							:to="`/dashboard/apikeys/${row.original.id}`"
							class="font-medium text-primary hover:underline"
						>
							{{ row.original.id }}
						</NuxtLink>
					</template>

					<template #description-cell="{ row }">
						<span class="line-clamp-1 max-w-xs text-slate-400">
							{{ row.original.description || "—" }}
						</span>
					</template>

					<template #created_at-cell="{ row }">
						<span class="text-sm">{{ formatDate(row.original.created_at) }}</span>
					</template>

					<template #expires_at-cell="{ row }">
						<span v-if="row.original.expires_at" class="text-sm" :class="isExpired(row.original) ? 'text-red-500' : ''">
							{{ formatDate(row.original.expires_at) }}
						</span>
						<span v-else class="text-sm text-slate-400">Never</span>
					</template>

					<template #status-cell="{ row }">
						<UBadge v-if="isExpired(row.original)" color="error" variant="soft" size="sm">Expired</UBadge>
						<UBadge v-else color="success" variant="soft" size="sm">Active</UBadge>
					</template>

					<template #actions-cell="{ row }">
						<UButton
							icon="i-lucide-trash"
							color="error"
							variant="ghost"
							size="sm"
							aria-label="Delete API key"
							@click="openDelete(row.original)"
						/>
					</template>

					<template #empty-actions>
						<UButton label="Create API Key" color="primary" to="/dashboard/apikeys/new" />
					</template>
				</DashboardDataTable>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>

	<DashboardDeleteModal
		v-model:open="deleteConfirmOpen"
		title="Delete API Key"
		warning-text="Anything using this API key will stop working. This action cannot be undone."
		:on-delete="onDeleteApiKey"
	/>
</template>
