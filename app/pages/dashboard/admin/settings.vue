<script setup lang="ts">
definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Server Settings | NetIgnite",
	description: "Server-wide settings",
});

const toast = useToast();

const settings = await useAPIAsyncData("admin-settings", async () => {
	const res = await useAPI((api) => api.getAdminSettings({}));
	if (!res.success) {
		toast.add({ title: "Failed to load settings", description: res.message, color: "error" });
		return null;
	}
	return res.data;
});

const saving = ref(false);

async function setRegistration(enabled: boolean) {
	saving.value = true;
	const res = await useAPI((api) =>
		api.putAdminSettings({ body: { registration_enabled: enabled } }),
	);
	saving.value = false;

	if (!res.success) {
		toast.add({ title: "Couldn't save the setting", description: res.message, color: "error" });
	} else {
		toast.add({
			title: enabled ? "Public sign-up enabled" : "Public sign-up disabled",
			color: "success",
			icon: "i-lucide-check",
		});
	}
	await settings.refresh();
}
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader title="Server Settings" icon="i-lucide-sliders-horizontal" description="Settings for this NetIgnite server" />
		</template>

		<template #body>
			<DashboardPageBody>
				<div class="mx-auto w-full space-y-6 lg:w-3xl">
					<DashboardSectionCard title="Registration" description="Who can create an account" icon="i-lucide-user-plus">
						<div class="flex items-start justify-between gap-4">
							<div>
								<h4 class="font-medium text-white">Public sign-up</h4>
								<p class="mt-1 text-sm text-slate-400">
									Anyone who can open this server can create an account at
									<code>/auth/signup</code>. Leave it off to create accounts yourself under
									<NuxtLink to="/dashboard/admin/users" class="text-primary hover:underline">Users</NuxtLink>.
								</p>
							</div>
							<USwitch
								:model-value="settings.data.value?.registration_enabled ?? false"
								:loading="saving || settings.loading.value"
								:disabled="!settings.data.value"
								aria-label="Public sign-up"
								@update:model-value="setRegistration"
							/>
						</div>
					</DashboardSectionCard>
				</div>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>
</template>
