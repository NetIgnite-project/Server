<script setup lang="ts">
/**
 * One-time welcome/onboarding page (Delivr pattern). `auth.global.ts` sends signed-in users here
 * until they finish or skip it (`REQUIRE_ONBOARDING`). Replace the steps with whatever your app
 * needs on first login (preferences, a first project, …) and persist them before `complete()`.
 */
import { useOnboardingStore } from "~/composables/stores/useOnboardingStore";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

definePageMeta({
	layout: "onboarding",
});

useSeoMeta({
	title: "Welcome | NetIgnite",
	description: "Get started with NetIgnite.",
});

const toast = useToast();

const onboardingStore = useOnboardingStore();
const [user] = await Promise.all([useUserInfoStore().use(), onboardingStore.refreshIfNeeded()]);

// Already onboarded (e.g. opened /welcome directly) → nothing to do here.
if (onboardingStore.completed.value) {
	await navigateTo("/dashboard");
}

const firstName = computed(() => user.value?.display_name?.trim().split(/\s+/)[0] || null);

const steps = [
	{
		icon: "i-lucide-user",
		title: "Complete your profile",
		description: "Check your display name and email address.",
		to: "/dashboard/settings",
	},
	{
		icon: "i-lucide-radio-tower",
		title: "Add an agent",
		description:
			"An ESP32 in the network of your devices, or the NetIgnite agent on a Linux, Windows or macOS machine.",
		to: "/dashboard/agents/new",
	},
	{
		icon: "i-lucide-monitor",
		title: "Add a device",
		description: "Enter its MAC address and power it on from anywhere.",
		to: "/dashboard/devices/new",
	},
];

const finishing = ref(false);

/** Mark onboarding done (so the first-login redirect stops firing), then continue. */
async function complete(to = "/dashboard") {
	finishing.value = true;
	try {
		await onboardingStore.update({ completed: true });
		await navigateTo(to);
	} catch (error) {
		toast.add({
			title: "Error",
			description: (error as Error).message || "Could not save your onboarding state.",
			icon: "i-lucide-x-circle",
			color: "error",
		});
		finishing.value = false;
	}
}
</script>

<template>
	<div class="space-y-6">
		<div class="text-center">
			<div class="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/15">
				<UIcon name="i-lucide-party-popper" class="size-7 text-primary-400" />
			</div>
			<h1 class="text-2xl font-semibold text-white">
				Welcome to NetIgnite<span v-if="firstName">, {{ firstName }}</span>
			</h1>
			<p class="mx-auto mt-2 max-w-md text-sm text-slate-400">
				A few things you may want to do first. You can come back to all of them later in Settings.
			</p>
		</div>

		<DashboardSectionCard
			title="Getting started"
			description="Pick any step — onboarding is marked complete either way"
			icon="i-lucide-list-checks"
			flush
		>
			<div class="divide-y divide-slate-800">
				<button
					v-for="step in steps"
					:key="step.title"
					type="button"
					class="flex w-full items-center gap-4 px-6 py-4 text-left transition hover:bg-slate-800/40 disabled:opacity-50"
					:disabled="finishing"
					@click="complete(step.to)"
				>
					<UIcon :name="step.icon" class="size-5 shrink-0 text-primary-400" />
					<div class="flex-1">
						<p class="font-medium text-white">{{ step.title }}</p>
						<p class="text-sm text-slate-400">{{ step.description }}</p>
					</div>
					<UIcon name="i-lucide-chevron-right" class="size-5 text-slate-500" />
				</button>
			</div>
		</DashboardSectionCard>

		<div class="flex items-center justify-between gap-3">
			<UButton label="Skip for now" color="neutral" variant="ghost" :disabled="finishing" @click="complete()" />
			<UButton
				label="Go to dashboard"
				color="primary"
				trailing-icon="i-lucide-arrow-right"
				:loading="finishing"
				@click="complete()"
			/>
		</div>
	</div>
</template>
