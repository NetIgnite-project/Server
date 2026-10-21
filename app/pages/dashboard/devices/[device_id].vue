<script setup lang="ts">
/**
 * Parent route for one device (`/dashboard/devices/new` or `/dashboard/devices/<id>`). Loads the
 * device once and hands it to the child pages via `useSubrouterInjectedData`.
 */
import type { NuxtError } from "#app";
import type { UseSubrouterPathDynamics } from "~/composables/useSubrouterPathDynamics";
import type { Device, NewDevice } from "~/utils/types";

definePageMeta({
	layout: "dashboard",
});

const route = useRoute();
const deviceParam = safeDecodeURIComponent(route.params.device_id as string);
const isNew = deviceParam === "new";

let error: NuxtError | null = null;
let device: ComputedRef<Device | null> | null = null;

if (isNew) {
	useSubrouterInjectedData<Device, NewDevice>("device", true).provide({
		data: ref<NewDevice>({
			name: "",
			type: "desktop",
			description: "",
			mac_address: "",
			wol_port: 9,
			agent_id: null,
			status_method: "none",
			status_address: null,
			status_tcp_port: null,
			host_agent_id: null,
		}),
		isNew: true,
	});
} else {
	const deviceID = Number(deviceParam);
	const {
		data: result,
		refresh,
		loading,
	} = await useAPIAsyncData(`device-${deviceID}`, async () =>
		Number.isInteger(deviceID) && deviceID > 0
			? await useAPI((api) => api.getDevicesByDeviceId({ path: { deviceID } }))
			: ({ success: false, code: 404, message: "Device not found" } as const),
	);

	if (!result.value?.success) {
		error = createError({
			statusCode: result.value?.code || 500,
			statusMessage: result.value?.message || "Failed to load device",
		});
	}

	device = computed(() => (result.value?.success ? result.value.data : null));

	useSubrouterInjectedData<Device, NewDevice>("device", true).provide({
		data: device as ComputedRef<Device>,
		refresh,
		loading,
		isNew: false,
	});
}

function getRoutesConfig(): UseSubrouterPathDynamics.RoutesConfig {
	const base = `/dashboard/devices/${deviceParam}`;
	const name = device?.value?.name ?? deviceParam;

	const routes: UseSubrouterPathDynamics.RoutesConfig = {
		[base]: {
			isNavLink: true,
			label: "General",
			icon: "i-lucide-monitor",
			exact: true,
			getDynamicValues() {
				return {
					seoSettings: {
						title: isNew ? "New Device" : name,
						description: isNew ? "Add a device" : `Manage ${name}`,
					},
					breadcrumbItems: [{ label: isNew ? "New device" : name }],
				};
			},
		},
	};

	if (!isNew && device?.value?.access_role === "owner") {
		routes[`${base}/sharing`] = {
			isNavLink: true,
			label: "Sharing",
			icon: "i-lucide-users",
			getDynamicValues() {
				return {
					seoSettings: { title: `Sharing · ${name}`, description: `Share ${name} with other users` },
					breadcrumbItems: [{ label: name, to: base }, { label: "Sharing" }],
				};
			},
		};
		routes[`${base}/ssh`] = {
			isNavLink: true,
			label: "SSH",
			icon: "i-lucide-key-square",
			getDynamicValues() {
				return {
					seoSettings: { title: `SSH · ${name}`, description: `SSH login of ${name}` },
					breadcrumbItems: [{ label: name, to: base }, { label: "SSH" }],
				};
			},
		};
	}

	return routes;
}

const subrouterPathDynamics = useSubrouterPathDynamics({
	baseTitle: "Devices | NetIgnite",
	basebreadcrumbItems: [{ label: "Devices", to: "/dashboard/devices" }],
	routes: getRoutesConfig(),
});

const routePathDynamicValues = await useAwaitedComputed(async () => {
	const values = await subrouterPathDynamics.getPathDynamicValues(route.path);
	useSeoMeta(values.seoSettings);
	return values;
});
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader icon="i-lucide-monitor" :breadcrumb-items="routePathDynamicValues.breadcrumbItems" />

			<UDashboardToolbar v-if="!isNew && !error">
				<UNavigationMenu :items="subrouterPathDynamics.links" highlight class="-mx-1 flex-1" />
			</UDashboardToolbar>
		</template>

		<template #body>
			<div class="flex w-full flex-col gap-4 sm:gap-6 lg:gap-12">
				<UError v-if="error" :error="error" />
				<NuxtPage v-else />
			</div>
		</template>
	</UDashboardPanel>
</template>
