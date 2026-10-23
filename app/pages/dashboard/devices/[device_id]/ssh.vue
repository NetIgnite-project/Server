<script setup lang="ts">
/**
 * The device's SSH login: the device's agent logs in with its own keys to shut it down or reboot
 * it. Owner only. Nothing secret is stored on the server: the page shows the agent's public keys
 * as authorized_keys lines, each limited to one command.
 */
import type {
	GetDevicesByDeviceIdSshResponses,
	PostDevicesByDeviceIdSshTestResponses,
	PutDevicesByDeviceIdSshData,
} from "~/api-client";
import { useUserInfoStore } from "~/composables/stores/useUserStore";
import type { Device, NewDevice } from "~/utils/types";

type SshLogin = GetDevicesByDeviceIdSshResponses["200"]["data"];
type TestResult = PostDevicesByDeviceIdSshTestResponses["200"]["data"];
type SshBody = NonNullable<PutDevicesByDeviceIdSshData["body"]>;

const toast = useToast();
const device = useSubrouterInjectedData<Device, NewDevice>("device", true).inject();
if (device.isNew || device.data.value.access_role !== "owner") {
	throw createError({ statusCode: 403, statusMessage: "Only the device's owner can set up SSH" });
}
const deviceID = device.data.value.id;

const user = await useUserInfoStore().use();
const isAdmin = computed(() => user.value?.role === "admin");

const login = await useAPIAsyncData<SshLogin | null>(`device-${deviceID}-ssh`, async () => {
	const res = await useAPI((api) => api.getDevicesByDeviceIdSsh({ path: { deviceID } }));
	return res.success ? res.data : null;
});

const form = reactive({
	host: login.data.value?.host ?? "",
	port: login.data.value?.port ?? 22,
	username: login.data.value?.username ?? "",
	os: login.data.value?.os ?? ("posix" as "posix" | "windows"),
	sudo: login.data.value?.sudo ?? true,
});

const saving = ref(false);

async function save() {
	const body: SshBody = {
		host: form.host.trim() || null,
		port: Number(form.port) || 22,
		username: form.username.trim(),
		os: form.os,
		sudo: form.sudo,
	};
	saving.value = true;
	const res = await useAPI((api) => api.putDevicesByDeviceIdSsh({ path: { deviceID }, body }));
	saving.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't save the SSH login", description: res.message, color: "error" });
		return;
	}
	login.data.value = res.data;
	test.value = null;
	toast.add({ title: "SSH login saved", color: "success", icon: "i-lucide-check" });
}

// --- Test and trust ------------------------------------------------------------------------------

const test = ref<TestResult | null>(null);
const testing = ref(false);

async function runTest() {
	testing.value = true;
	const res = await useAPI((api) => api.postDevicesByDeviceIdSshTest({ path: { deviceID } }));
	testing.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't test the login", description: res.message, color: "error" });
		return;
	}
	test.value = res.data;
}

async function trust() {
	if (!test.value?.host_key) return;
	const res = await useAPI((api) =>
		api.postDevicesByDeviceIdSshTrust({
			path: { deviceID },
			body: { host_key: test.value?.host_key as string },
		}),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't trust the host key", description: res.message, color: "error" });
		return;
	}
	login.data.value = res.data;
	test.value = { ...test.value, trusted: true };
	toast.add({
		title: "Host key trusted",
		description: "Shutdown and reboot now work over SSH.",
		color: "success",
	});
	await device.refresh?.();
}

const testSummary = computed(() => {
	const result = test.value;
	if (!result?.online) return null;
	if (result.error === "host_key_mismatch") {
		return {
			color: "error" as const,
			title: "The device presents another host key",
			description:
				"It differs from the trusted one, so the agent didn't log in. If you reinstalled the device, trust the new key; otherwise someone may be intercepting the connection.",
		};
	}
	if (result.shutdown && result.reboot) {
		return {
			color: result.trusted ? ("success" as const) : ("info" as const),
			title: "Both keys work",
			description: result.trusted
				? undefined
				: "Trust the host key below to allow shutdown and reboot.",
		};
	}
	const missing = [!result.shutdown && "shutdown", !result.reboot && "reboot"]
		.filter(Boolean)
		.join(" and ");
	return {
		color: "warning" as const,
		title: `The device didn't accept the ${missing} key`,
		description:
			result.error && result.error !== "auth_failed"
				? result.error
				: "Check the username and that both lines are in the authorized_keys file shown above.",
	};
});

const removeOpen = ref(false);

async function remove() {
	const res = await useAPI((api) => api.deleteDevicesByDeviceIdSsh({ path: { deviceID } }));
	if (!res.success) {
		toast.add({ title: "Couldn't remove the SSH login", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({ title: "SSH login removed", color: "success" });
	await login.refresh();
	test.value = null;
	await device.refresh?.();
}

// Accounts that can do anything: if a line lost its forced command, the key could too. "all" would
// make even the sudoers line apply to everyone.
const privilegedUser = computed(
	() =>
		form.os === "posix" &&
		["root", "administrator", "admin", "all"].includes(
			form.username.trim().toLowerCase().split("\\").pop() ?? "",
		),
);

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.add({ title: "Copied to clipboard", icon: "i-lucide-clipboard-check", color: "success" });
	} catch {
		toast.add({
			title: "Copy failed",
			description: "Select the text and copy it manually.",
			color: "warning",
		});
	}
}
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<DashboardSectionCard
			title="SSH login"
			description="The device's agent logs in over SSH to shut it down or reboot it"
			icon="i-lucide-key-square"
		>
			<UAlert
				class="mb-6"
				color="info"
				variant="subtle"
				icon="i-lucide-shield"
				title="Prefer the NetIgnite agent on the device"
				description="If the device runs Linux, Windows or macOS, install the NetIgnite agent on it and choose it under Agent on the device (General tab) instead. It can only shut down and reboot that machine, and no login to the device exists at all. Use SSH for devices that can't run the agent."
			/>

			<UAlert
				v-if="login.data.value && !login.data.value.enabled"
				color="warning"
				variant="subtle"
				icon="i-lucide-power-off"
				title="SSH is turned off on this server"
				:description="isAdmin ? 'Turn it on under Server Settings to shut devices down and reboot them over SSH.' : 'An admin can turn it on under Server Settings.'"
				:actions="isAdmin ? [{ label: 'Server Settings', to: '/dashboard/admin/settings', color: 'neutral', variant: 'outline' }] : []"
			/>

			<template v-else-if="login.data.value">
				<p class="mb-6 text-sm text-slate-400">
					No password or key is stored on the server. The device's agent has two keys of its own, one
					for shutdown and one for reboot, and keeps them. You allow them on the device with two lines,
					each limited to its one command.
				</p>

				<UAlert
					v-if="!login.data.value.agent_ready"
					class="mb-6"
					color="warning"
					variant="subtle"
					icon="i-lucide-radio-tower"
					title="This device's agent can't log in over SSH right now"
					description="SSH needs an online agent in the device's network: an ESP32 with firmware newer than 2.0.0, or a Linux agent newer than 1.0.0 in Wake-on-LAN mode, connected to this server over HTTPS. Choose it as the device's agent (General tab)."
				/>

				<form class="space-y-5" @submit.prevent="save">
					<div class="grid gap-4 sm:grid-cols-[1fr_8rem]">
						<UFormField label="Host" :description="`Empty: the status address${login.data.value.effective_host && !form.host ? ` (${login.data.value.effective_host})` : ''}`">
							<UInput v-model="form.host" placeholder="nas.local or 192.168.1.20" class="w-full" />
						</UFormField>
						<UFormField label="Port"><UInput v-model.number="form.port" type="number" min="1" max="65535" class="w-full" /></UFormField>
					</div>
					<UFormField label="Username" required :description="form.os === 'windows' ? 'An administrator account (Windows only shuts down for administrators).' : 'A dedicated user without other rights, e.g. netignite.'">
						<UInput v-model="form.username" placeholder="netignite" class="w-full sm:w-80" autocomplete="off" />
					</UFormField>
					<UAlert
						v-if="privilegedUser"
						color="warning"
						variant="subtle"
						icon="i-lucide-triangle-alert"
						title="Use a dedicated user instead"
						description="The lines below limit the agent's keys to shutdown and reboot. With a user that has no other rights, a key still can't do more if a line loses its forced command."
					/>
					<UFormField label="Operating system">
						<URadioGroup
							v-model="form.os"
							orientation="horizontal"
							:items="[
								{ value: 'posix', label: 'Linux, macOS, BSD' },
								{ value: 'windows', label: 'Windows (OpenSSH)' },
							]"
						/>
					</UFormField>
					<USwitch
						v-if="form.os === 'posix'"
						v-model="form.sudo"
						label="Use sudo"
						description="Runs shutdown with sudo -n (not needed for root)."
					/>
					<div class="flex justify-end">
						<UButton type="submit" :label="login.data.value.configured ? 'Save' : 'Save login'" icon="i-lucide-save" :loading="saving" />
					</div>
				</form>
			</template>
		</DashboardSectionCard>

		<template v-if="login.data.value?.enabled && login.data.value.configured">
			<DashboardSectionCard title="Prepare the device" description="Do this on the device once" icon="i-lucide-list-checks">
				<div class="space-y-5 text-sm">
					<div v-if="login.data.value.authorized_keys">
						<p class="text-slate-300">
							Add these two lines to
							<code class="font-mono">{{ login.data.value.authorized_keys_file }}</code>
							<template v-if="login.data.value.os === 'posix'">
								of <strong>{{ login.data.value.username }}</strong></template>.
							Each key can only run its command; the agent's private keys never leave it.
						</p>
						<div class="mt-2 flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
							<code class="flex-1 whitespace-pre-wrap break-all font-mono text-xs text-slate-200">{{ login.data.value.authorized_keys }}</code>
							<UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="sm" aria-label="Copy" @click="copy(`${login.data.value.authorized_keys}\n`)" />
						</div>
						<p v-if="login.data.value.os === 'windows'" class="mt-2 text-xs text-slate-400">
							Only Administrators and SYSTEM may have access to that file.
						</p>
						<p class="mt-2 text-xs text-slate-400">
							Optional: accept the keys only from the agent by adding
							<code class="font-mono">from="&lt;agent's IP address&gt;",</code> after
							<code class="font-mono">restrict,</code>.
						</p>
					</div>
					<UAlert
						v-else
						color="warning"
						variant="subtle"
						icon="i-lucide-key-round"
						title="The device's agent hasn't reported its SSH keys yet"
						description="It sends them when it connects, if it can log in over SSH (see above). The lines appear here then."
					/>
					<div v-if="login.data.value.sudoers">
						<p class="text-slate-300">
							Allow only shutdown and reboot without a password:
							<code class="font-mono">sudo visudo -f /etc/sudoers.d/netignite</code>, then add:
						</p>
						<div class="mt-2 flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
							<code class="flex-1 break-all font-mono text-xs text-slate-200">{{ login.data.value.sudoers }}</code>
							<UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="sm" aria-label="Copy" @click="copy(login.data.value.sudoers as string)" />
						</div>
					</div>
				</div>
			</DashboardSectionCard>

			<DashboardSectionCard
				title="Host key"
				description="Trusted on first use, so nobody can impersonate the device later"
				icon="i-lucide-fingerprint"
			>
				<div class="space-y-4">
					<p class="text-sm text-slate-300">
						Trusted key:
						<code v-if="login.data.value.host_key" class="break-all font-mono text-xs text-emerald-300">{{ login.data.value.host_key }}</code>
						<span v-else class="text-amber-300">none yet. Shutdown and reboot over SSH work after you trust it.</span>
					</p>

					<UButton
						label="Test login"
						icon="i-lucide-plug-zap"
						color="neutral"
						variant="outline"
						:loading="testing"
						:disabled="!login.data.value.agent_ready"
						@click="runTest"
					/>

					<template v-if="test">
						<UAlert
							v-if="!test.online"
							color="error"
							variant="subtle"
							icon="i-lucide-circle-x"
							title="The device didn't answer on its SSH port"
							:description="test.error ?? undefined"
						/>
						<template v-else>
							<UAlert
								v-if="testSummary"
								:color="testSummary.color"
								variant="subtle"
								:icon="testSummary.color === 'success' || testSummary.color === 'info' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
								:title="testSummary.title"
								:description="testSummary.description"
							/>
							<div v-if="test.host_key && !test.trusted" class="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm">
								<p class="text-slate-300">The device presented this host key:</p>
								<code class="mt-2 block break-all font-mono text-xs text-white">{{ test.host_key }}</code>
								<p class="mt-2 text-xs text-slate-400">
									Compare it on the device, e.g. <code class="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>.
								</p>
								<UButton class="mt-3" label="Trust this host key" icon="i-lucide-shield-check" @click="trust" />
							</div>
						</template>
					</template>
				</div>
			</DashboardSectionCard>
		</template>

		<DashboardSectionCard v-if="login.data.value?.configured" title="Remove" icon="i-lucide-trash-2" tone="danger">
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<p class="flex-1 text-sm text-slate-400">Removes the SSH login. Remove the two lines from the device too.</p>
				<UButton label="Remove SSH login" color="error" variant="soft" icon="i-lucide-trash-2" @click="removeOpen = true" />
			</div>
		</DashboardSectionCard>

		<DashboardDeleteModal
			v-model:open="removeOpen"
			title="Remove SSH Login"
			warning-text="Shutdown and reboot over SSH stop working until you set it up again."
			:on-delete="remove"
		/>
	</div>
</template>
