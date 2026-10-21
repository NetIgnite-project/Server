<script setup lang="ts">
/**
 * The device's SSH login: the device's agent logs in to shut it down or reboot it. Owner only;
 * the password or private key never comes back from the server.
 */
import type {
	GetDevicesByDeviceIdSshResponses,
	PostDevicesByDeviceIdSshTestResponses,
	PutDevicesByDeviceIdSshData,
} from "~/api-client";
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
	auth: (login.data.value?.configured ? "keep" : "generate_key") as
		| "generate_key"
		| "password"
		| "keep",
	password: "",
});

const authItems = computed(() => [
	...(login.data.value?.configured
		? [
				{
					value: "keep",
					label: "Keep the current",
					description: login.data.value.auth_type === "key" ? "Key pair" : "Password",
				},
			]
		: []),
	{
		value: "generate_key",
		label: "New key pair",
		description: "Recommended: the server creates an Ed25519 key",
	},
	{
		value: "password",
		label: "Password",
		description: "Stored encrypted, only sent to the device's agent",
	},
]);

const saving = ref(false);

async function save() {
	const body: SshBody = {
		host: form.host.trim() || null,
		port: Number(form.port) || 22,
		username: form.username.trim(),
		os: form.os,
		sudo: form.sudo,
		auth:
			form.auth === "password"
				? { type: "password", password: form.password }
				: form.auth === "keep"
					? { type: "keep" }
					: { type: "generate_key" },
	};
	saving.value = true;
	const res = await useAPI((api) => api.putDevicesByDeviceIdSsh({ path: { deviceID }, body }));
	saving.value = false;
	if (!res.success) {
		toast.add({ title: "Couldn't save the SSH login", description: res.message, color: "error" });
		return;
	}
	login.data.value = res.data;
	form.auth = "keep";
	form.password = "";
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

const TEST_ERRORS: Record<string, string> = {
	host_key_mismatch:
		"The device presents a different host key than the trusted one. If you reinstalled it, trust the new key; otherwise someone may be intercepting the connection.",
	auth_failed:
		"The device refused the login. Check the username and the password or authorized_keys.",
};

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

// Logins that can do anything on the device: the stored secret then grants full control.
const privilegedUser = computed(() =>
	["root", "administrator", "admin"].includes(
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
				title="Prefer the NetIgnite Linux agent"
				description="For a Linux machine, install the Linux agent on it and choose it as the device's Linux agent instead: it can only shut down and reboot that machine, and no login to it is stored on the server. With SSH, the server keeps a login to the device (encrypted) and sends it to the agent for every command. If you use SSH, log in as a dedicated user without other rights that may only shut down and reboot (see Prepare the device), never as root or an administrator, and prefer a generated key over a password."
			/>

			<UAlert
				v-if="login.data.value && !login.data.value.agent_ready"
				class="mb-6"
				color="warning"
				variant="subtle"
				icon="i-lucide-radio-tower"
				title="This device's agent can't log in over SSH"
				description="SSH needs an online agent in the device's network that can log in over SSH: an ESP32 with firmware 2.0.0-beta.2 or newer, or a Linux agent in Wake-on-LAN mode. Assign it as the device's agent (General tab)."
			/>

			<form class="space-y-5" @submit.prevent="save">
				<div class="grid gap-4 sm:grid-cols-[1fr_8rem]">
					<UFormField label="Host" :description="`Empty: the status address${login.data.value?.effective_host && !form.host ? ` (${login.data.value.effective_host})` : ''}`">
						<UInput v-model="form.host" placeholder="nas.local or 192.168.1.20" class="w-full" />
					</UFormField>
					<UFormField label="Port"><UInput v-model.number="form.port" type="number" min="1" max="65535" class="w-full" /></UFormField>
				</div>
				<UFormField label="Username" required description="A dedicated user without other rights, e.g. netignite.">
					<UInput v-model="form.username" placeholder="netignite" class="w-full sm:w-80" autocomplete="off" />
				</UFormField>
				<UAlert
					v-if="privilegedUser"
					color="warning"
					variant="subtle"
					icon="i-lucide-triangle-alert"
					title="This login can do anything on the device"
					description="Anyone who gets hold of it (e.g. from a server backup and its secrets key) controls the device. Create a user that may only shut down and reboot instead."
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
				<UFormField label="Authentication">
					<URadioGroup v-model="form.auth" :items="authItems" variant="card" class="w-full" />
				</UFormField>
				<UFormField v-if="form.auth === 'password'" label="Password" required>
					<UInput v-model="form.password" type="password" class="w-full sm:w-80" autocomplete="new-password" />
				</UFormField>
				<div class="flex justify-end">
					<UButton type="submit" :label="login.data.value?.configured ? 'Save' : 'Save login'" icon="i-lucide-save" :loading="saving" />
				</div>
			</form>
		</DashboardSectionCard>

		<DashboardSectionCard
			v-if="login.data.value?.configured && (login.data.value.authorized_keys || login.data.value.sudoers)"
			title="Prepare the device"
			description="Run these on the device once"
			icon="i-lucide-list-checks"
		>
			<div class="space-y-5 text-sm">
				<div v-if="login.data.value.authorized_keys">
					<p class="text-slate-300">
						Add this line to <code class="font-mono">~/.ssh/authorized_keys</code> of
						<strong>{{ login.data.value.username }}</strong>:
					</p>
					<div class="mt-2 flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
						<code class="flex-1 break-all font-mono text-xs text-slate-200">{{ login.data.value.authorized_keys }}</code>
						<UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="sm" aria-label="Copy" @click="copy(login.data.value.authorized_keys as string)" />
					</div>
				</div>
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
			v-if="login.data.value?.configured"
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
					/>
					<template v-else>
						<UAlert
							:color="test.authenticated && test.trusted ? 'success' : test.authenticated ? 'info' : 'warning'"
							variant="subtle"
							:icon="test.authenticated ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
							:title="test.authenticated ? 'Login works' : 'Login failed'"
							:description="test.error ? (TEST_ERRORS[test.error] ?? test.error) : undefined"
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

		<DashboardSectionCard v-if="login.data.value?.configured" title="Remove" icon="i-lucide-trash-2" tone="danger">
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<p class="flex-1 text-sm text-slate-400">Deletes the stored password or key. Remove the key from the device too.</p>
				<UButton label="Remove SSH login" color="error" variant="soft" icon="i-lucide-trash-2" @click="removeOpen = true" />
			</div>
		</DashboardSectionCard>

		<DashboardDeleteModal
			v-model:open="removeOpen"
			title="Remove SSH Login"
			warning-text="Shutdown and reboot over SSH stop working until you set a new login."
			:on-delete="remove"
		/>
	</div>
</template>
