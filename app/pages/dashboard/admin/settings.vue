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

// --- Firmware ---

const firmwareSync = await useAPIAsyncData("admin-firmware-sync", async () => {
	const res = await useAPI((api) => api.getAdminFirmware({}));
	return res.success ? res.data : null;
});

const firmware = await useAPIAsyncData("admin-firmware-catalog", async () => {
	const res = await useAPI((api) => api.getFirmware({}));
	return res.success ? res.data : null;
});

const channelItems = [
	{ value: "stable", label: "Stable releases" },
	{ value: "prerelease", label: "Include pre-releases" },
];

async function setChannel(channel: "stable" | "prerelease") {
	saving.value = true;
	const res = await useAPI((api) => api.putAdminSettings({ body: { firmware_channel: channel } }));
	saving.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't save the setting", description: res.message, color: "error" });
	}
	await Promise.all([settings.refresh(), firmware.refresh()]);
}

const syncing = ref(false);

async function syncNow() {
	syncing.value = true;
	const res = await useAPI((api) => api.postAdminFirmwareSync({}));
	syncing.value = false;

	if (!res.success) {
		toast.add({ title: "Firmware sync failed", description: res.message, color: "error" });
	} else {
		const { added, removed, skipped } = res.data;
		const changes = [
			added.length > 0 ? `added ${added.join(", ")}` : null,
			removed.length > 0 ? `removed ${removed.join(", ")}` : null,
		].filter(Boolean);
		toast.add({
			title: changes.length > 0 ? "Firmware updated" : "Firmware is up to date",
			description: [changes.join("; "), ...skipped.map((s) => `Skipped ${s.version}: ${s.reason}`)]
				.filter(Boolean)
				.join(". "),
			color: skipped.length > 0 ? "warning" : "success",
			icon: "i-lucide-check",
		});
	}
	await Promise.all([firmwareSync.refresh(), firmware.refresh()]);
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

					<DashboardSectionCard
						title="ESP32 firmware"
						description="Releases for the web installer, synced from GitHub"
						icon="i-lucide-cpu"
					>
						<div class="space-y-6">
							<div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
								<div>
									<h4 class="font-medium text-white">Default channel</h4>
									<p class="mt-1 text-sm text-slate-400">
										Which release the installer recommends. Users can still pick any synced release.
									</p>
								</div>
								<USelect
									:model-value="settings.data.value?.firmware_channel ?? 'stable'"
									:items="channelItems"
									:disabled="!settings.data.value || saving"
									class="w-full md:w-56"
									aria-label="Firmware channel"
									@update:model-value="setChannel"
								/>
							</div>

							<div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
								<div class="text-sm">
									<h4 class="font-medium text-white">Sync</h4>
									<p class="mt-1 text-slate-400">
										From
										<a
											v-if="firmwareSync.data.value"
											:href="`https://github.com/${firmwareSync.data.value.repo}/releases`"
											target="_blank"
											rel="noopener"
											class="text-primary hover:underline"
											>{{ firmwareSync.data.value.repo }}</a
										>
										<template v-if="firmwareSync.data.value?.enabled">, automatically every 6 hours.</template>
										<template v-else>. Automatic sync is off (NETIGNITE_FIRMWARE_SYNC).</template>
										<template v-if="firmwareSync.data.value?.signature_required"> Only signed releases are accepted.</template>
									</p>
									<p class="mt-1 text-slate-500">
										Last successful sync: {{ formatRelative(firmwareSync.data.value?.last_success_at) }}
									</p>
									<p v-if="firmwareSync.data.value?.error" class="mt-1 text-red-400">
										Last attempt failed: {{ firmwareSync.data.value.error }}
									</p>
								</div>
								<UButton
									label="Sync now"
									icon="i-lucide-refresh-cw"
									color="neutral"
									variant="outline"
									:loading="syncing"
									@click="syncNow"
								/>
							</div>

							<ul v-if="(firmware.data.value?.releases.length ?? 0) > 0" class="divide-y divide-slate-800 rounded-lg border border-slate-800">
								<li v-for="release in firmware.data.value?.releases" :key="release.version" class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
									<a :href="release.release_url" target="_blank" rel="noopener" class="font-mono text-white hover:underline">{{ release.version }}</a>
									<UBadge v-if="release.version === firmware.data.value?.recommended" color="primary" variant="soft" size="sm">recommended</UBadge>
									<UBadge v-if="release.prerelease" color="warning" variant="soft" size="sm">pre-release</UBadge>
									<UBadge v-if="release.signature_verified" color="success" variant="soft" size="sm">signed</UBadge>
									<span class="ml-auto text-slate-500">{{ formatDate(release.published_at) }}</span>
								</li>
							</ul>
							<p v-else class="text-sm text-slate-500">No firmware releases synced yet.</p>
						</div>
					</DashboardSectionCard>
				</div>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>
</template>
