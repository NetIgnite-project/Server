<script setup lang="ts">
import type { BreadcrumbItem } from "@nuxt/ui";

const props = withDefaults(
	defineProps<{
		title?: string;
		icon?: string;
		description?: string;
		breadcrumbItems?: BreadcrumbItem[];
	}>(),
	{
		title: "",
		icon: undefined,
	},
);
</script>

<template>
	<UDashboardNavbar :title="props.title" :icon="props.icon">
		<template #leading>
			<slot name="leading"></slot>
		</template>

		<template v-if="breadcrumbItems?.length" #title>
			<slot name="title">
				<UBreadcrumb :items="breadcrumbItems" :ui="{ link: 'text-md' }" />
			</slot>
		</template>

		<template v-if="description" #trailing>
			<slot name="trailing">
				<span class="hidden text-slate-400 sm:inline">
					{{ description }}
				</span>
			</slot>
		</template>

		<template #left>
			<slot name="left"></slot>
		</template>

		<template #default>
			<slot></slot>
		</template>

		<template #right>
			<slot name="right"></slot>
		</template>
	</UDashboardNavbar>
</template>
