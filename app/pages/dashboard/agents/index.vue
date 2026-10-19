<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { Agent } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Agents | NetIgnite",
	description: "The agents that wake and check your devices",
});

const toast = useToast();

const columns: TableColumn<Agent>[] = [
	{ accessorKey: "name", header: "Name" },
	{ accessorKey: "kind", header: "Kind" },
	{ accessorKey: "state", header: "Status" },
	{ accessorKey: "version", header: "Version" },
	{ accessorKey: "last_seen_at", header: "Last seen" },
];

const agents = await useAPIAsyncData<Agent[]>("agents", async () => {
	const res = await useAPI((api) => api.getAgents({}));
	if (!res.success) {
		toast.add({ title: "Failed to load agents", description: res.message, color: "error" });
		return [];
	}
	return res.data;
});

useInterval(() => agents.refresh(), 20_000);

const stateOptions = Object.entries(AgentStates).map(([value, state]) => ({
	label: state.label,
	value,
}));
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader
				title="Agents"
				icon="i-lucide-radio-tower"
				description="Agents live in your networks and wake devices for you"
			/>
		</template>

		<template #body>
			<DashboardPageBody>
				<DashboardDataTable
					:data="agents.data"
					:columns="columns"
					:loading="agents.loading"
					:filters="[
						{ column: 'name', type: 'text', placeholder: 'Search agents...', icon: 'i-lucide-search' },
						{ column: 'state', type: 'select', placeholder: 'All statuses', options: stateOptions },
					]"
					empty-title="No agents"
					empty-description="Add an agent in each network that contains devices you want to wake."
					empty-icon="i-lucide-radio-tower"
					@refresh="agents.refresh()"
				>
					<template #header-right>
						<UButton label="Add agent" icon="i-lucide-plus" to="/dashboard/agents/new" />
					</template>

					<template #name-cell="{ row }">
						<NuxtLink :to="`/dashboard/agents/${row.original.id}`" class="font-medium text-primary hover:underline">
							{{ row.original.name }}
						</NuxtLink>
						<p v-if="row.original.description" class="line-clamp-1 max-w-xs text-sm text-slate-400">
							{{ row.original.description }}
						</p>
					</template>

					<template #kind-cell="{ row }">
						<span class="inline-flex items-center gap-2 text-sm">
							<UIcon :name="AgentKinds[row.original.kind].icon" class="size-4 text-slate-400" />
							{{ AgentKinds[row.original.kind].label }}
						</span>
					</template>

					<template #state-cell="{ row }">
						<UBadge :color="AgentStates[row.original.state].color" variant="soft">
							{{ AgentStates[row.original.state].label }}
						</UBadge>
					</template>

					<template #version-cell="{ row }">
						<span class="font-mono text-sm text-slate-300">{{ row.original.version ?? "—" }}</span>
					</template>

					<template #last_seen_at-cell="{ row }">
						<span class="text-sm text-slate-400">
							{{ row.original.state === "online" ? "now" : formatRelative(row.original.last_seen_at) }}
						</span>
					</template>

					<template #empty-actions>
						<UButton label="Add agent" color="primary" to="/dashboard/agents/new" />
					</template>
				</DashboardDataTable>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>
</template>
