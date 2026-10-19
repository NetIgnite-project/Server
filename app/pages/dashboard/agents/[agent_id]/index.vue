<script setup lang="ts">
import { zPostAgentsBody } from "~/api-client/zod.gen";
import type { Agent, Device, NewAgent } from "~/utils/types";

const toast = useToast();
const { appUrl } = useRuntimeAppConfigs();

const agent = useSubrouterInjectedData<Agent, NewAgent>("agent", true).inject();

const formState = ref<NewAgent>(
	agent.isNew
		? { ...agent.data.value }
		: {
				name: agent.data.value.name,
				description: agent.data.value.description,
				kind: agent.data.value.kind,
			},
);
const formSchema = zPostAgentsBody;
const saving = ref(false);

const kindOptions = [
	{
		value: "esp32",
		label: "ESP32",
		description:
			"A small board in your network, flashed from the browser. Wakes devices and checks their status.",
	},
	{
		value: "linux",
		label: "Linux agent",
		description:
			"A service for an always-on Linux machine (e.g. a Raspberry Pi or a server). Reports its own status, can shut it down, and can wake other devices.",
	},
];

async function onSubmit() {
	saving.value = true;
	const res = agent.isNew
		? await useAPI((api) => api.postAgents({ body: formState.value }))
		: await useAPI((api) =>
				api.putAgentsByAgentId({
					path: { agentID: agent.data.value.id },
					body: { name: formState.value.name, description: formState.value.description },
				}),
			);
	saving.value = false;

	if (!res.success) {
		toast.add({
			title: "Couldn't save the agent",
			description: res.message,
			color: "error",
			icon: "i-lucide-alert-circle",
		});
		return;
	}
	toast.add({
		title: agent.isNew ? "Agent created" : "Agent saved",
		color: "success",
		icon: "i-lucide-check",
	});
	if (agent.isNew) {
		await navigateTo(`/dashboard/agents/${res.data.id}`);
	} else {
		await agent.refresh();
	}
}

// --- Existing agents ---

if (!agent.isNew) useInterval(() => agent.refresh(), 15_000);

const devices = await useAPILazyAsyncData<Device[]>("agent-devices", async () => {
	if (agent.isNew) return [];
	const res = await useAPI((api) => api.getDevices({}));
	const id = agent.data.value.id;
	return res.success
		? res.data.filter((device) => device.agent_id === id || device.host_agent_id === id)
		: [];
});

const infoEntries = computed(() =>
	agent.isNew || !agent.data.value.info
		? []
		: Object.entries(agent.data.value.info).map(([key, value]) => ({
				key,
				value: typeof value === "object" ? JSON.stringify(value) : String(value),
			})),
);

const enrollment = ref<{ token: string; expires_at: number } | null>(null);
const creatingEnrollment = ref(false);

async function createEnrollment() {
	if (agent.isNew) return;
	creatingEnrollment.value = true;
	const res = await useAPI((api) =>
		api.postAgentsByAgentIdEnrollments({ path: { agentID: agent.data.value.id } }),
	);
	creatingEnrollment.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't create a pairing token", description: res.message, color: "error" });
		return;
	}
	enrollment.value = res.data;
}

const pairCommand = computed(() =>
	enrollment.value ? `sudo netignite-agent pair ${appUrl} ${enrollment.value.token}` : "",
);

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.add({ title: "Copied to clipboard", icon: "i-lucide-clipboard-check", color: "success" });
	} catch {
		toast.add({
			title: "Copy failed",
			description: "Select the text and copy it manually.",
			color: "warning",
		});
	}
}

const revokeOpen = ref(false);
const deleteOpen = ref(false);

async function onRevoke() {
	if (agent.isNew) return;
	const res = await useAPI((api) =>
		api.postAgentsByAgentIdRevoke({ path: { agentID: agent.data.value.id } }),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't revoke the credential", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({
		title: "Credential revoked",
		description: "The agent was disconnected.",
		color: "success",
	});
	await agent.refresh();
}

async function onDelete() {
	if (agent.isNew) return;
	const res = await useAPI((api) =>
		api.deleteAgentsByAgentId({ path: { agentID: agent.data.value.id } }),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't delete the agent", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({ title: "Agent deleted", color: "success" });
	await navigateTo("/dashboard/agents");
}
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<!-- New agent -->
		<template v-if="agent.isNew">
			<div>
				<h2 class="text-xl font-semibold text-white">Add an agent</h2>
				<p class="mt-1 text-sm text-slate-400">
					An agent sits in the same network as your devices and keeps a connection to NetIgnite.
				</p>
			</div>

			<DashboardSectionCard title="Agent" icon="i-lucide-radio-tower">
				<UForm :schema="formSchema" :state="formState" class="space-y-6" @submit="onSubmit">
					<UFormField name="kind" label="Kind">
						<URadioGroup v-model="formState.kind" :items="kindOptions" variant="card" class="w-full" />
					</UFormField>
					<UFormField name="name" label="Name" required>
						<UInput v-model="formState.name" placeholder="Office ESP32" class="w-full" />
					</UFormField>
					<UFormField name="description" label="Description">
						<UTextarea v-model="formState.description" :rows="2" autoresize placeholder="Optional" class="w-full" />
					</UFormField>
					<div class="flex justify-end">
						<UButton type="submit" label="Create agent" icon="i-lucide-plus" :loading="saving" />
					</div>
				</UForm>
			</DashboardSectionCard>
		</template>

		<!-- Existing agent -->
		<template v-else>
			<DashboardSectionCard title="Status" icon="i-lucide-activity">
				<dl class="grid gap-4 sm:grid-cols-2">
					<div>
						<dt class="text-sm text-slate-400">Connection</dt>
						<dd class="mt-1">
							<UBadge :color="AgentStates[agent.data.value.state].color" variant="soft">
								{{ AgentStates[agent.data.value.state].label }}
							</UBadge>
						</dd>
					</div>
					<div>
						<dt class="text-sm text-slate-400">Kind</dt>
						<dd class="mt-1 flex items-center gap-2 text-white">
							<UIcon :name="AgentKinds[agent.data.value.kind].icon" class="size-4" />
							{{ AgentKinds[agent.data.value.kind].label }}
						</dd>
					</div>
					<div>
						<dt class="text-sm text-slate-400">Version</dt>
						<dd class="mt-1 font-mono text-white">{{ agent.data.value.version ?? "—" }}</dd>
					</div>
					<div>
						<dt class="text-sm text-slate-400">Last seen</dt>
						<dd class="mt-1 text-white">
							{{ agent.data.value.state === "online" ? "Connected now" : formatRelative(agent.data.value.last_seen_at) }}
						</dd>
					</div>
				</dl>

				<div v-if="agent.data.value.capabilities.length > 0" class="mt-6">
					<p class="text-sm text-slate-400">Capabilities</p>
					<div class="mt-2 flex flex-wrap gap-2">
						<UBadge v-for="capability in agent.data.value.capabilities" :key="capability" color="neutral" variant="subtle">
							{{ capability }}
						</UBadge>
					</div>
				</div>

				<dl v-if="infoEntries.length > 0" class="mt-6 divide-y divide-slate-800 rounded-lg border border-slate-800">
					<div v-for="entry in infoEntries" :key="entry.key" class="flex justify-between gap-4 px-4 py-2 text-sm">
						<dt class="text-slate-400">{{ entry.key }}</dt>
						<dd class="truncate font-mono text-slate-200">{{ entry.value }}</dd>
					</div>
				</dl>
			</DashboardSectionCard>

			<DashboardSectionCard
				:title="agent.data.value.state === 'unenrolled' ? 'Set up' : 'Set up again'"
				:description="agent.data.value.state === 'unenrolled' ? 'Connect this agent to NetIgnite' : 'Replaces the current credential'"
				icon="i-lucide-plug"
			>
				<template v-if="agent.data.value.kind === 'esp32'">
					<UAlert
						color="info"
						variant="soft"
						icon="i-lucide-usb"
						title="Install from your browser"
						description="The browser installer for the ESP32 firmware comes with the v2 firmware. Until then, use a manual enrollment token below."
					/>
				</template>

				<template v-else>
					<p class="text-sm text-slate-300">
						Install the NetIgnite Linux agent on the machine, then run the pairing command on it. The
						command works once and expires after 15 minutes.
					</p>
				</template>

				<div class="mt-4 space-y-3">
					<UButton
						:label="enrollment ? 'Create a new token' : agent.data.value.kind === 'linux' ? 'Create pairing command' : 'Create enrollment token'"
						icon="i-lucide-key-round"
						color="neutral"
						variant="outline"
						:loading="creatingEnrollment"
						@click="createEnrollment"
					/>

					<template v-if="enrollment">
						<div class="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
							<code class="flex-1 break-all font-mono text-sm text-slate-200">
								{{ agent.data.value.kind === "linux" ? pairCommand : enrollment.token }}
							</code>
							<UButton
								icon="i-lucide-copy"
								color="neutral"
								variant="ghost"
								size="sm"
								aria-label="Copy"
								@click="copy(agent.data.value.kind === 'linux' ? pairCommand : enrollment.token)"
							/>
						</div>
						<p class="text-xs text-slate-500">
							Valid until {{ formatDate(enrollment.expires_at) }}. The agent generates its own secret when it
							uses this token; NetIgnite never shows it.
						</p>
					</template>
				</div>
			</DashboardSectionCard>

			<DashboardSectionCard title="Settings" icon="i-lucide-settings">
				<UForm :schema="formSchema" :state="formState" class="divide-y divide-slate-800" @submit="onSubmit">
					<UFormField name="name" label="Name" required class="flex items-start justify-between gap-4 py-4 first:pt-0 max-sm:flex-col" :ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }">
						<UInput v-model="formState.name" class="w-full" />
					</UFormField>
					<UFormField name="description" label="Description" class="flex items-start justify-between gap-4 py-4 max-sm:flex-col" :ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-80' }">
						<UTextarea v-model="formState.description" :rows="2" autoresize class="w-full" />
					</UFormField>
					<div class="flex justify-end pt-4">
						<UButton type="submit" label="Save" icon="i-lucide-save" :loading="saving" />
					</div>
				</UForm>
			</DashboardSectionCard>

			<DashboardSectionCard title="Devices" description="Devices this agent wakes or runs on" icon="i-lucide-monitor" flush>
				<UEmpty
					v-if="!devices.loading.value && (devices.data.value?.length ?? 0) === 0"
					variant="naked"
					icon="i-lucide-monitor"
					title="No devices use this agent"
					:actions="[{ label: 'Add device', icon: 'i-lucide-plus', to: '/dashboard/devices/new' }]"
					class="py-8"
				/>
				<ul v-else class="divide-y divide-slate-800">
					<li v-for="device in devices.data.value" :key="device.id" class="flex items-center gap-3 px-6 py-3">
						<UIcon :name="DeviceTypes[device.type].icon" class="size-4 text-slate-400" />
						<NuxtLink :to="`/dashboard/devices/${device.id}`" class="flex-1 text-white hover:underline">{{ device.name }}</NuxtLink>
						<DevicesStatusBadge :status="device.status" />
					</li>
				</ul>
			</DashboardSectionCard>

			<DashboardSectionCard title="Danger Zone" description="Irreversible actions" icon="i-lucide-alert-triangle" tone="danger">
				<div class="space-y-6">
					<div class="flex flex-col gap-4 md:flex-row md:items-center">
						<div class="flex-1">
							<h4 class="font-medium text-white">Revoke credential</h4>
							<p class="mt-1 text-sm text-slate-400">Disconnects the agent. It has to be set up again.</p>
						</div>
						<UButton
							label="Revoke"
							color="error"
							variant="soft"
							icon="i-lucide-shield-off"
							:disabled="agent.data.value.state === 'unenrolled'"
							@click="revokeOpen = true"
						/>
					</div>
					<div class="flex flex-col gap-4 md:flex-row md:items-center">
						<div class="flex-1">
							<h4 class="font-medium text-white">Delete agent</h4>
							<p class="mt-1 text-sm text-slate-400">Devices that use it keep their settings but can't be woken.</p>
						</div>
						<UButton label="Delete agent" color="error" variant="soft" icon="i-lucide-trash-2" @click="deleteOpen = true" />
					</div>
				</div>
			</DashboardSectionCard>
		</template>
	</div>

	<template v-if="!agent.isNew">
		<DashboardDeleteModal
			v-model:open="revokeOpen"
			title="Revoke Credential"
			warning-text="The agent is disconnected and can only reconnect after it is set up again."
			:on-delete="onRevoke"
		/>
		<DashboardDeleteModal
			v-model:open="deleteOpen"
			title="Delete Agent"
			warning-text="The agent is disconnected and deleted. This can't be undone."
			:on-delete="onDelete"
		/>
	</template>
</template>
