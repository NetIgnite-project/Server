<script setup lang="ts">
/**
 * Web installer for ESP32 agents (ESP Web Tools): flashes the firmware with an NVS image holding
 * the server URL and a single-use enrollment token, then sets up Wi-Fi over Improv. The Wi-Fi
 * password goes from the browser to the device only.
 */
import { useUserInfoStore } from "~/composables/stores/useUserStore";
import type { Agent, NewAgent } from "~/utils/types";

const injected = useSubrouterInjectedData<Agent, NewAgent>("agent", true).inject();
if (injected.isNew) await navigateTo("/dashboard/agents/new");
const agent = computed(() => injected.data.value as Agent);

const toast = useToast();
const { appUrl } = useRuntimeAppConfigs();
const apiBase = `${appUrl.replace(/\/$/, "")}/api/v1`;

const user = await useUserInfoStore().use();
const isAdmin = computed(() => user.value?.role === "admin");

const catalog = await useAPIAsyncData("firmware-catalog", async () => {
	const res = await useAPI((api) => api.getFirmware({}));
	return res.success ? res.data : null;
});
const releases = computed(() => catalog.data.value?.releases ?? []);

const version = ref<string | undefined>(
	catalog.data.value?.recommended ?? catalog.data.value?.releases[0]?.version,
);
const versionItems = computed(() =>
	releases.value.map((release) => ({
		value: release.version,
		label:
			release.version === catalog.data.value?.recommended
				? `${release.version} (recommended)`
				: release.prerelease
					? `${release.version} (pre-release)`
					: release.version,
	})),
);
const selectedRelease = computed(() => releases.value.find((r) => r.version === version.value));

const serverURL = ref(appUrl);
const showAdvanced = ref(false);

// --- Prepare ------------------------------------------------------------------------------------

const prepared = shallowRef<PreparedInstall | null>(null);
const preparing = ref(false);
const downloaded = ref(0);
/** The agent's enrollment time before this install; a change means the new token was used. */
const enrolledBefore = ref<number | null>(null);
const now = ref(Date.now());

const expired = computed(() => prepared.value !== null && now.value >= prepared.value.expiresAt);
const connected = computed(
	() =>
		prepared.value !== null &&
		agent.value.state === "online" &&
		agent.value.enrolled_at !== enrolledBefore.value,
);

async function prepare() {
	const release = selectedRelease.value;
	if (!release) return;

	preparing.value = true;
	downloaded.value = 0;
	try {
		const sessionToken = useAppCookies().sessionToken.get().value ?? null;
		const parts: { blob: Blob; offset: number }[] = [];
		for (const part of release.parts) {
			parts.push({
				blob: await downloadFirmwarePart(apiBase, sessionToken, release, part),
				offset: part.offset,
			});
			downloaded.value += 1;
		}

		const custom = serverURL.value.trim().replace(/\/$/, "");
		const res = await useAPI((api) =>
			api.postAgentsByAgentIdFlashImage({
				path: { agentID: agent.value.id },
				body: {
					version: release.version,
					server_url: custom && custom !== appUrl.replace(/\/$/, "") ? custom : undefined,
				},
			}),
		);
		if (!res.success) throw new Error(res.message);
		parts.push({ blob: base64ToBlob(res.data.image), offset: res.data.offset });

		prepared.value?.dispose();
		enrolledBefore.value = agent.value.enrolled_at;
		prepared.value = createInstall(release, parts, res.data.expires_at);
		now.value = Date.now();
	} catch (error) {
		toast.add({
			title: "Couldn't prepare the installer",
			description: (error as Error).message,
			color: "error",
			icon: "i-lucide-alert-circle",
		});
	} finally {
		preparing.value = false;
	}
}

function reset() {
	prepared.value?.dispose();
	prepared.value = null;
}

watch(version, reset);

// --- ESP Web Tools and connection status ----------------------------------------------------------

onMounted(async () => {
	// The prebuilt bundle: the package's ES modules expect an older @material/web than npm installs.
	await import("esp-web-tools/dist/web/install-button.js");
});
onBeforeUnmount(() => prepared.value?.dispose());

useInterval(async () => {
	now.value = Date.now();
	if (prepared.value && !connected.value) await injected.refresh?.();
}, 3000);

watch(connected, (value) => {
	if (value) {
		toast.add({
			title: `${agent.value.name} is connected`,
			color: "success",
			icon: "i-lucide-check",
		});
	}
});
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<DashboardSectionCard
			title="Install from the browser"
			description="Flash the NetIgnite firmware over USB and connect the ESP32 to Wi-Fi"
			icon="i-lucide-usb"
		>
			<UAlert
				v-if="releases.length === 0"
				color="warning"
				variant="subtle"
				icon="i-lucide-package-x"
				title="No firmware available yet"
				:description="
					isAdmin
						? 'This server hasn\'t downloaded any firmware release. Sync them under Server Settings.'
						: 'This server hasn\'t downloaded any firmware release yet. Ask your administrator.'
				"
				:actions="isAdmin ? [{ label: 'Server Settings', to: '/dashboard/admin/settings', color: 'neutral', variant: 'outline' }] : []"
			/>

			<ol v-else class="space-y-8">
				<!-- 1. Firmware -->
				<li class="flex gap-4">
					<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary-300">1</span>
					<div class="flex-1 space-y-3">
						<div>
							<h4 class="font-medium text-white">Choose the firmware</h4>
							<p class="mt-1 text-sm text-slate-400">For ESP32 boards (ESP32-WROOM / ESP32-WROVER, e.g. "ESP32 DevKit").</p>
						</div>
						<USelect v-model="version" :items="versionItems" class="w-full sm:w-72" aria-label="Firmware version" />
						<p v-if="selectedRelease" class="text-xs text-slate-500">
							Released {{ formatDate(selectedRelease.published_at) }} ·
							<a :href="selectedRelease.release_url" target="_blank" rel="noopener" class="text-primary hover:underline">Release notes</a>
							<template v-if="selectedRelease.signature_verified"> · signature verified</template>
						</p>

						<UButton
							:label="showAdvanced ? 'Hide server address' : 'Change server address'"
							:icon="showAdvanced ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
							color="neutral"
							variant="link"
							size="sm"
							class="px-0"
							@click="showAdvanced = !showAdvanced"
						/>
						<UFormField
							v-if="showAdvanced"
							label="Server address"
							description="The address the agent connects to. Change it only if the agent reaches this server under another address, e.g. inside your network."
						>
							<UInput v-model="serverURL" class="w-full" @update:model-value="reset" />
						</UFormField>
					</div>
				</li>

				<!-- 2. Prepare -->
				<li class="flex gap-4">
					<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary-300">2</span>
					<div class="flex-1 space-y-3">
						<div>
							<h4 class="font-medium text-white">Prepare the installer</h4>
							<p class="mt-1 text-sm text-slate-400">
								Downloads the firmware and creates this agent's setup data with a single-use token. Installing
								replaces the agent's current credential and the ESP32's Wi-Fi settings.
							</p>
						</div>
						<UButton
							:label="prepared ? 'Prepare again' : 'Prepare installer'"
							icon="i-lucide-package-check"
							:color="prepared && !expired ? 'neutral' : 'primary'"
							:variant="prepared && !expired ? 'outline' : 'solid'"
							:loading="preparing"
							:disabled="!selectedRelease"
							@click="prepare"
						/>
						<p v-if="preparing && selectedRelease" class="text-xs text-slate-500">
							Downloading firmware… {{ downloaded }}/{{ selectedRelease.parts.length }}
						</p>
						<UAlert
							v-if="expired"
							color="warning"
							variant="subtle"
							icon="i-lucide-timer-off"
							title="The setup token expired"
							description="Prepare the installer again before you install."
						/>
						<p v-else-if="prepared" class="flex items-center gap-1.5 text-sm text-emerald-400">
							<UIcon name="i-lucide-check" class="size-4" />
							Ready: firmware {{ prepared.version }}. Install before {{ formatDate(prepared.expiresAt) }}.
						</p>
					</div>
				</li>

				<!-- 3. Install -->
				<li class="flex gap-4">
					<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary-300">3</span>
					<div class="flex-1 space-y-3">
						<div>
							<h4 class="font-medium text-white">Connect and install</h4>
							<p class="mt-1 text-sm text-slate-400">
								Plug the ESP32 into this computer, click the button and pick its serial port. After the install,
								enter your Wi-Fi in the dialog: the password goes straight to the ESP32, not to NetIgnite.
							</p>
						</div>
						<ClientOnly>
							<esp-web-install-button v-if="prepared && !expired" :manifest="prepared.manifestURL">
								<UButton slot="activate" label="Connect and install" icon="i-lucide-usb" />
								<UAlert
									slot="unsupported"
									color="warning"
									variant="subtle"
									icon="i-lucide-monitor-x"
									title="This browser can't access USB devices"
									description="Use Google Chrome, Microsoft Edge or Firefox (151 or newer) on a computer, or set the agent up over its serial console (General tab)."
								/>
								<UAlert
									slot="not-allowed"
									color="warning"
									variant="subtle"
									icon="i-lucide-shield-alert"
									title="Installing needs HTTPS"
									description="Browsers only allow USB access on HTTPS pages (or localhost). Open NetIgnite over HTTPS."
								/>
							</esp-web-install-button>
							<UButton v-else label="Connect and install" icon="i-lucide-usb" disabled />
						</ClientOnly>
					</div>
				</li>

				<!-- 4. Connected -->
				<li class="flex gap-4">
					<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary-300">4</span>
					<div class="flex-1 space-y-3">
						<h4 class="font-medium text-white">Wait for the agent</h4>
						<UAlert
							v-if="connected"
							color="success"
							variant="subtle"
							icon="i-lucide-circle-check"
							:title="`${agent.name} is connected`"
							:description="`Firmware ${agent.version ?? ''}. You can close the installer and add devices to this agent.`"
							:actions="[{ label: 'Add device', icon: 'i-lucide-plus', to: '/dashboard/devices/new', color: 'neutral', variant: 'outline' }]"
						/>
						<p v-else-if="prepared" class="flex items-center gap-2 text-sm text-slate-400">
							<UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
							Once it's on Wi-Fi, the agent connects to NetIgnite on its own. This page updates when it does.
						</p>
						<p v-else class="text-sm text-slate-500">The agent shows up here once it's connected.</p>
					</div>
				</li>
			</ol>
		</DashboardSectionCard>

		<DashboardSectionCard title="Already installed?" icon="i-lucide-wifi" description="Change Wi-Fi without reinstalling">
			<p class="text-sm text-slate-300">
				Prepare the installer and click <em>Connect and install</em>: for an ESP32 that already runs NetIgnite, the
				dialog offers <em>Change Wi-Fi</em> and <em>Logs &amp; console</em> without touching the firmware or its
				credential.
			</p>
		</DashboardSectionCard>
	</div>
</template>
