<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

const route = useRoute();
const user = await useUserInfoStore().use();

const links = computed<NavigationMenuItem[]>(() => [
	{ label: "Dashboard", to: "/dashboard" },
	{ label: "Docs", to: "https://netignite.dev/docs", target: "_blank" },
]);

const profileLabel = computed(() => user.value?.display_name || user.value?.username || "Profile");

const loginRoute = computed(() =>
	route.path.startsWith("/auth")
		? "/auth/login"
		: `/auth/login?url=${encodeURIComponent(route.fullPath)}`,
);
</script>

<template>
	<UHeader class="backdrop-blur-xl" title="NetIgnite" to="/dashboard">
		<template #title>
			<ImgAppLogo class="h-8" />
		</template>

		<UNavigationMenu :items="links" />

		<template #body>
			<UNavigationMenu :items="links" orientation="vertical" class="w-full" />
		</template>

		<template #right>
			<div class="flex items-center gap-2">
				<template v-if="user">
					<div class="hidden items-center gap-1.5 text-white sm:flex">
						<UIcon name="i-lucide-user" class="size-4" />
						<span class="text-sm">{{ profileLabel }}</span>
					</div>
					<UButton
						icon="i-lucide-layout-dashboard"
						to="/dashboard"
						color="primary"
						variant="soft"
						class="hidden sm:flex"
					>
						Dashboard
					</UButton>
				</template>

				<UButton v-else icon="i-lucide-log-in" :to="loginRoute" color="primary" variant="solid">
					Login
				</UButton>
			</div>
		</template>
	</UHeader>
</template>
