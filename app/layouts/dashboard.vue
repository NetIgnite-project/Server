<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

const user = await useUserInfoStore().use();
const isAdmin = computed(() => user.value?.role === "admin");

const mainItems: NavigationMenuItem[] = [
	{
		label: "Overview",
		icon: "i-lucide-layout-dashboard",
		to: "/dashboard",
		exact: true,
	},
	{
		label: "Devices",
		icon: "i-lucide-monitor",
		to: "/dashboard/devices",
	},
	{
		label: "Agents",
		icon: "i-lucide-radio-tower",
		to: "/dashboard/agents",
	},
];

const settingsItems: NavigationMenuItem[] = [
	{
		label: "Settings",
		icon: "i-lucide-settings",
		type: "label",
	},
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
	{
		label: "API Keys",
		icon: "i-lucide-key",
		to: "/dashboard/apikeys",
	},
];

const adminItems: NavigationMenuItem[] = [
	{
		label: "Admin",
		icon: "i-lucide-shield",
		type: "label",
	},
	{
		label: "Users",
		icon: "i-lucide-users",
		to: "/dashboard/admin/users",
	},
	{
		label: "Server Settings",
		icon: "i-lucide-sliders-horizontal",
		to: "/dashboard/admin/settings",
	},
];

const footerItems: NavigationMenuItem[] = [
	{
		label: "Documentation",
		icon: "i-lucide-book-open",
		to: "https://netignite.dev/docs",
		target: "_blank",
	},
	{
		label: "API Reference",
		icon: "i-lucide-braces",
		to: "/api/docs/v1",
		target: "_blank",
	},
];
</script>

<template>
	<NuxtLoadingIndicator color="var(--ui-primary)" position="top" />

	<UDashboardGroup class="main-bg-color text-slate-100">
		<UDashboardSidebar
			collapsible
			resizable
			:ui="{
				header: 'main-bg-color',
				body: 'main-bg-color',
				content: 'main-bg-color',
				footer: 'border-t border-default main-bg-color',
			}"
			:min-size="18"
			:default-size="20"
			:max-size="30"
		>
			<template #header="{ collapsed }">
				<NuxtLink to="/dashboard" :class="`${!collapsed ? 'ms-2.5' : ''} flex items-center gap-1.5`">
					<ImgAppLogo v-if="!collapsed" class="h-7" />
					<ImgAppIcon v-else class="h-8 w-8" />
				</NuxtLink>
			</template>

			<template #default="{ collapsed }">
				<UNavigationMenu :collapsed="collapsed" :items="mainItems" orientation="vertical" />

				<UNavigationMenu :collapsed="collapsed" :items="settingsItems" orientation="vertical" />

				<UNavigationMenu
					v-if="isAdmin"
					:collapsed="collapsed"
					:items="adminItems"
					orientation="vertical"
				/>

				<UNavigationMenu
					:collapsed="collapsed"
					:items="footerItems"
					orientation="vertical"
					class="mt-auto"
				/>
			</template>

			<template #footer="{ collapsed }">
				<DashboardUserMenu :collapsed="collapsed" />
			</template>
		</UDashboardSidebar>

		<slot />
	</UDashboardGroup>
</template>
