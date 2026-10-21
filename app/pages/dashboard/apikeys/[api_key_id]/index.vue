<script setup lang="ts">
import type { PostAccountApikeysResponses } from "~/api-client";
import { zPostAccountApikeysBody } from "~/api-client/zod.gen";
import type { APIKey, NewAPIKey } from "~/utils/types";

const toast = useToast();

const apiKey = useSubrouterInjectedData<APIKey, NewAPIKey>("api_key", true).inject();

const formState = ref<NewAPIKey>(
	apiKey.isNew
		? { ...apiKey.data.value }
		: { description: apiKey.data.value.description, expires_at: null },
);

// Referenced here (not only in the template) so Biome keeps it a value import.
const formSchema = apiKey.isNew ? zPostAccountApikeysBody : undefined;

const expiryOptions = [
	{ label: "7 Days", value: "7d" },
	{ label: "30 Days", value: "30d" },
	{ label: "90 Days", value: "90d" },
	{ label: "180 Days", value: "180d" },
	{ label: "365 Days", value: "365d" },
	{ label: "No Expiration", value: null },
];

const creating = ref(false);
const createdKey = ref<PostAccountApikeysResponses["200"]["data"] | null>(null);
const revealToken = ref(false);

async function onCreate() {
	creating.value = true;

	const result = await useAPI((api) =>
		api.postAccountApikeys({
			body: {
				description: formState.value.description,
				expires_at: formState.value.expires_at,
			},
		}),
	);

	creating.value = false;

	if (result.success) {
		toast.add({
			title: "API key created",
			description: "Copy the token now — it is only shown once.",
			icon: "i-lucide-check",
			color: "success",
		});
		createdKey.value = result.data;
	} else {
		toast.add({
			title: "Error",
			description: result.message || "Failed to create API key.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
	}
}

async function copyToken() {
	if (!createdKey.value) return;
	try {
		await navigator.clipboard.writeText(createdKey.value.token);
		toast.add({ title: "Copied to clipboard", icon: "i-lucide-clipboard-check", color: "success" });
	} catch {
		toast.add({
			title: "Copy failed",
			description: "Select the token and copy it manually.",
			color: "warning",
		});
	}
}

/** Close the one-time token dialog and go to the new key's page. */
async function onTokenDialogClose() {
	if (!createdKey.value) return;
	const id = createdKey.value.id;
	createdKey.value = null;
	await navigateTo(`/dashboard/apikeys/${id}`);
}

const deleteConfirmOpen = ref(false);

async function onDeleteApiKey() {
	if (apiKey.isNew) return;
	const apiKeyID = apiKey.data.value.id;

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
	await navigateTo("/dashboard/apikeys");
}

const headerTexts = computed(() =>
	apiKey.isNew
		? { title: "Create New API Key", description: "Create a key for scripts and integrations." }
		: { title: `API Key ${apiKey.data.value.id}`, description: "View and manage this API key." },
);
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<div>
			<h2 class="text-xl font-semibold text-white">{{ headerTexts.title }}</h2>
			<p class="mt-1 text-sm text-slate-400">{{ headerTexts.description }}</p>
		</div>

		<DashboardSectionCard
			title="API Key Information"
			description="API keys can't be edited — create a new one instead."
			icon="i-lucide-info"
		>
			<UForm
				class="divide-y divide-slate-800"
				:schema="formSchema"
				:state="formState"
				:disabled="!apiKey.isNew"
				@submit="onCreate"
			>
				<UFormField
					name="description"
					label="Description"
					description="What this key is used for."
					class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
					:ui="{ container: 'w-full' }"
				>
					<UTextarea
						v-model="formState.description"
						placeholder="No description provided."
						:rows="3"
						autoresize
						class="w-full"
					/>
				</UFormField>

				<UFormField
					name="expires_at"
					label="Expiration"
					description="When this key stops working."
					class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
					:ui="{ container: 'w-full sm:w-60' }"
				>
					<USelect
						v-if="apiKey.isNew"
						v-model="formState.expires_at"
						:items="expiryOptions"
						placeholder="Select expiration"
						class="w-full"
					/>
					<UInput
						v-else
						:model-value="apiKey.data.value.expires_at ? formatDate(apiKey.data.value.expires_at) : 'Never'"
						disabled
						class="w-full"
					/>
				</UFormField>

				<div v-if="apiKey.isNew" class="pt-4">
					<UButton
						label="Create API Key"
						color="primary"
						type="submit"
						:loading="creating"
						icon="i-lucide-plus-circle"
					/>
				</div>
			</UForm>
		</DashboardSectionCard>

		<DashboardSectionCard
			v-if="!apiKey.isNew"
			title="Danger Zone"
			description="Irreversible and destructive actions"
			icon="i-lucide-alert-triangle"
			tone="danger"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<div class="flex-1">
					<h4 class="font-medium text-white">Delete API Key</h4>
					<p class="mt-1 text-sm text-slate-400">Anything using this key stops working immediately.</p>
				</div>
				<UButton
					label="Delete API Key"
					color="error"
					variant="soft"
					icon="i-lucide-trash-2"
					@click="deleteConfirmOpen = true"
				/>
			</div>
		</DashboardSectionCard>

		<DashboardDeleteModal
			v-if="!apiKey.isNew"
			v-model:open="deleteConfirmOpen"
			title="Delete API Key"
			warning-text="Anything using this API key will stop working. This action cannot be undone."
			:on-delete="onDeleteApiKey"
		/>

		<!-- One-time token dialog -->
		<DashboardModal
			:open="!!createdKey"
			title="API Key Created"
			description="Copy your new API key now. You won't be able to see it again."
			icon="i-lucide-check-circle"
			icon-color="emerald"
			:dismissible="false"
			:close="false"
		>
			<div class="space-y-4">
				<div class="rounded-lg border border-red-900/50 bg-red-950/50 p-4">
					<p class="text-sm text-red-300">
						<strong>Warning:</strong>
						The API key is only shown once. Store it somewhere safe.
					</p>
				</div>

				<UFormField label="API Key">
					<UInput
						:model-value="createdKey?.token"
						readonly
						:type="revealToken ? 'text' : 'password'"
						class="w-full"
						:ui="{ trailing: 'pe-1' }"
					>
						<template #trailing>
							<UButton
								color="neutral"
								variant="link"
								size="sm"
								:icon="revealToken ? 'i-lucide-eye-off' : 'i-lucide-eye'"
								:aria-label="revealToken ? 'Hide key' : 'Show key'"
								:aria-pressed="revealToken"
								@click="revealToken = !revealToken"
							/>
							<UButton
								color="neutral"
								variant="link"
								size="sm"
								icon="i-lucide-copy"
								aria-label="Copy key"
								@click="copyToken"
							/>
						</template>
					</UInput>
				</UFormField>
			</div>

			<template #footer>
				<UButton label="Done" color="primary" @click="onTokenDialogClose" />
			</template>
		</DashboardModal>
	</div>
</template>
