<script setup lang="ts">
import { zPostDevicesByDeviceIdSharesBody } from "~/api-client/zod.gen";
import type { Device, DeviceShare, NewDevice } from "~/utils/types";

const toast = useToast();
const device = useSubrouterInjectedData<Device, NewDevice>("device", true).inject();

if (device.isNew || device.data.value.access_role !== "owner") {
	throw createError({ statusCode: 403, statusMessage: "Only the device's owner can share it" });
}
const deviceID = device.data.value.id;

const shares = await useAPIAsyncData<DeviceShare[]>(`device-${deviceID}-shares`, async () => {
	const res = await useAPI((api) => api.getDevicesByDeviceIdShares({ path: { deviceID } }));
	if (!res.success) {
		toast.add({ title: "Failed to load shares", description: res.message, color: "error" });
		return [];
	}
	return res.data;
});

const roleOptions = (["viewer", "operator", "manager"] as const).map((role) => ({
	label: AccessRoles[role].label,
	value: role,
	description: AccessRoles[role].description,
}));

type ShareRole = DeviceShare["role"];

const formSchema = zPostDevicesByDeviceIdSharesBody;
const formState = ref<{ user: string; role: ShareRole }>({ user: "", role: "operator" });
const sharing = ref(false);

async function onShare() {
	sharing.value = true;
	const res = await useAPI((api) =>
		api.postDevicesByDeviceIdShares({ path: { deviceID }, body: { ...formState.value } }),
	);
	sharing.value = false;

	if (!res.success) {
		toast.add({
			title: "Couldn't share the device",
			description: res.message,
			color: "error",
			icon: "i-lucide-alert-circle",
		});
		return;
	}
	toast.add({
		title: `Shared with ${res.data.user.display_name}`,
		color: "success",
		icon: "i-lucide-check",
	});
	formState.value.user = "";
	await shares.refresh();
}

async function changeRole(share: DeviceShare, role: ShareRole) {
	const res = await useAPI((api) =>
		api.putDevicesByDeviceIdSharesByUserId({
			path: { deviceID, userID: share.user.id },
			body: { role },
		}),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't change the role", description: res.message, color: "error" });
	}
	await shares.refresh();
}

async function removeShare(share: DeviceShare) {
	const res = await useAPI((api) =>
		api.deleteDevicesByDeviceIdSharesByUserId({ path: { deviceID, userID: share.user.id } }),
	);
	if (!res.success) {
		toast.add({ title: "Couldn't remove the share", description: res.message, color: "error" });
		return;
	}
	toast.add({ title: `${share.user.display_name} no longer has access`, color: "success" });
	await shares.refresh();
}
</script>

<template>
	<div class="mx-auto w-full space-y-6 lg:w-3xl">
		<div>
			<h2 class="text-xl font-semibold text-white">Sharing</h2>
			<p class="mt-1 text-sm text-slate-400">
				Let other users see or control this device. Commands still go through your agent; you stay the
				owner.
			</p>
		</div>

		<DashboardSectionCard title="Share with a user" icon="i-lucide-user-plus">
			<UForm :schema="formSchema" :state="formState" class="flex flex-col gap-4 sm:flex-row sm:items-start" @submit="onShare">
				<UFormField name="user" class="flex-1">
					<UInput v-model="formState.user" placeholder="Username or email address" icon="i-lucide-at-sign" class="w-full" />
				</UFormField>
				<UFormField name="role">
					<USelect v-model="formState.role" :items="roleOptions" class="w-full sm:w-40" />
				</UFormField>
				<UButton type="submit" label="Share" icon="i-lucide-share-2" :loading="sharing" />
			</UForm>

			<ul class="mt-4 space-y-1 text-sm text-slate-400">
				<li v-for="role in roleOptions" :key="role.value">
					<strong class="text-slate-200">{{ role.label }}</strong>: {{ role.description }}
				</li>
			</ul>
		</DashboardSectionCard>

		<DashboardSectionCard title="People with access" icon="i-lucide-users" flush>
			<UEmpty
				v-if="!shares.loading.value && (shares.data.value?.length ?? 0) === 0"
				variant="naked"
				icon="i-lucide-users"
				title="Not shared yet"
				description="Only you can see this device."
				class="py-10"
			/>
			<ul v-else class="divide-y divide-slate-800">
				<li v-for="share in shares.data.value" :key="share.user.id" class="flex flex-wrap items-center gap-4 px-6 py-4">
					<div class="min-w-0 flex-1">
						<p class="font-medium text-white">{{ share.user.display_name }}</p>
						<p class="text-sm text-slate-400">@{{ share.user.username }} · shared {{ formatRelative(share.created_at) }}</p>
					</div>
					<USelect
						:model-value="share.role"
						:items="roleOptions"
						class="w-36"
						@update:model-value="(role) => changeRole(share, role as ShareRole)"
					/>
					<UButton
						icon="i-lucide-x"
						color="error"
						variant="ghost"
						:aria-label="`Remove ${share.user.display_name}`"
						@click="removeShare(share)"
					/>
				</li>
			</ul>
		</DashboardSectionCard>
	</div>
</template>
