<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Settings | NetIgnite",
	description: "Manage your account settings",
});

const links = [
	[
		{
			label: "General",
			icon: "i-lucide-user",
			to: "/dashboard/settings",
			exact: true,
		},
		{
			label: "Security",
			icon: "i-lucide-shield",
			to: "/dashboard/settings/security",
		},
	],
] satisfies NavigationMenuItem[][];
</script>

<template>
	<UDashboardPanel id="settings" :ui="{ body: 'lg:py-12' }">
		<template #header>
			<DashboardPageHeader title="Settings" icon="i-lucide-settings" />

			<UDashboardToolbar>
				<!-- `-mx-1` aligns the menu with the sidebar collapse button. -->
				<UNavigationMenu :items="links" highlight class="-mx-1 flex-1" />
			</UDashboardToolbar>
		</template>

		<template #body>
			<div class="mx-auto flex w-full flex-col gap-4 sm:gap-6 lg:max-w-3xl lg:gap-12">
				<NuxtPage />
			</div>
		</template>
	</UDashboardPanel>
</template>
