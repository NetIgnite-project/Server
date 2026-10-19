<script setup lang="ts">
/**
 * Parent route for one agent (`/dashboard/agents/new` or `/dashboard/agents/<id>`).
 */
import type { NuxtError } from "#app";
import type { UseSubrouterPathDynamics } from "~/composables/useSubrouterPathDynamics";
import type { Agent, NewAgent } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

const route = useRoute();
const agentParam = safeDecodeURIComponent(route.params.agent_id as string);
const isNew = agentParam === "new";

let error: NuxtError | null = null;
let agent: ComputedRef<Agent | null> | null = null;

if (isNew) {
	useSubrouterInjectedData<Agent, NewAgent>("agent", true).provide({
		data: ref<NewAgent>({ name: "", description: "", kind: "esp32" }),
		isNew: true,
	});
} else {
	const agentID = Number(agentParam);
	const {
		data: result,
		refresh,
		loading,
	} = await useAPIAsyncData(`agent-${agentID}`, async () =>
		Number.isInteger(agentID) && agentID > 0
			? await useAPI((api) => api.getAgentsByAgentId({ path: { agentID } }))
			: ({ success: false, code: 404, message: "Agent not found" } as const),
	);

	if (!result.value?.success) {
		error = createError({
			statusCode: result.value?.code || 500,
			statusMessage: result.value?.message || "Failed to load agent",
		});
	}

	agent = computed(() => (result.value?.success ? result.value.data : null));

	useSubrouterInjectedData<Agent, NewAgent>("agent", true).provide({
		data: agent as ComputedRef<Agent>,
		refresh,
		loading,
		isNew: false,
	});
}

function getRoutesConfig(): UseSubrouterPathDynamics.RoutesConfig {
	const name = agent?.value?.name ?? agentParam;
	return {
		[`/dashboard/agents/${agentParam}`]: {
			isNavLink: true,
			label: "General",
			icon: "i-lucide-radio-tower",
			exact: true,
			getDynamicValues() {
				return {
					seoSettings: {
						title: isNew ? "New Agent" : name,
						description: isNew ? "Add an agent" : `Manage agent ${name}`,
					},
					breadcrumbItems: [{ label: isNew ? "New agent" : name }],
				};
			},
		},
	};
}

const subrouterPathDynamics = useSubrouterPathDynamics({
	baseTitle: "Agents | NetIgnite",
	basebreadcrumbItems: [{ label: "Agents", to: "/dashboard/agents" }],
	routes: getRoutesConfig(),
});

const routePathDynamicValues = await useAwaitedComputed(async () => {
	const values = await subrouterPathDynamics.getPathDynamicValues(route.path);
	useSeoMeta(values.seoSettings);
	return values;
});
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader icon="i-lucide-radio-tower" :breadcrumb-items="routePathDynamicValues.breadcrumbItems" />
		</template>

		<template #body>
			<div class="flex w-full flex-col gap-4 sm:gap-6 lg:gap-12">
				<UError v-if="error" :error="error" />
				<NuxtPage v-else />
			</div>
		</template>
	</UDashboardPanel>
</template>
