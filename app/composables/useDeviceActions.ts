import type { Device } from "~/utils/types";

type PowerAction = "power-on" | "shutdown" | "reboot";

const ACTION_TEXTS: Record<PowerAction, { success: string; failure: string }> = {
	"power-on": { success: "Wake-on-LAN packet sent", failure: "Couldn't power on" },
	shutdown: { success: "Shutdown requested", failure: "Couldn't shut down" },
	reboot: { success: "Reboot requested", failure: "Couldn't reboot" },
};

/** Power actions and status refresh for devices, with toasts and a per-device busy state. */
export function useDeviceActions() {
	const toast = useToast();
	const busy = ref(new Set<number>());

	async function run(device: Pick<Device, "id" | "name">, action: PowerAction) {
		busy.value.add(device.id);
		try {
			const path = { deviceID: device.id };
			const res = await useAPI((api) =>
				action === "power-on"
					? api.postDevicesByDeviceIdPowerOn({ path })
					: action === "shutdown"
						? api.postDevicesByDeviceIdShutdown({ path })
						: api.postDevicesByDeviceIdReboot({ path }),
			);

			if (res.success) {
				toast.add({
					title: ACTION_TEXTS[action].success,
					description: device.name,
					color: "success",
					icon: "i-lucide-check",
				});
			} else {
				toast.add({
					title: ACTION_TEXTS[action].failure,
					description: res.message,
					color: "error",
					icon: "i-lucide-alert-circle",
				});
			}
			return res.success;
		} finally {
			busy.value.delete(device.id);
		}
	}

	async function refreshStatus(device: Pick<Device, "id">) {
		busy.value.add(device.id);
		try {
			const res = await useAPI((api) =>
				api.postDevicesByDeviceIdStatus({ path: { deviceID: device.id } }),
			);
			return res.success ? res.data : null;
		} finally {
			busy.value.delete(device.id);
		}
	}

	async function setFavorite(device: Pick<Device, "id">, favorite: boolean) {
		const path = { deviceID: device.id };
		const res = await useAPI((api) =>
			favorite
				? api.putDevicesByDeviceIdFavorite({ path })
				: api.deleteDevicesByDeviceIdFavorite({ path }),
		);
		if (!res.success) {
			toast.add({ title: "Couldn't update favorites", description: res.message, color: "error" });
		}
		return res.success;
	}

	return {
		isBusy: (device: Pick<Device, "id">) => busy.value.has(device.id),
		powerOn: (device: Pick<Device, "id" | "name">) => run(device, "power-on"),
		shutdown: (device: Pick<Device, "id" | "name">) => run(device, "shutdown"),
		reboot: (device: Pick<Device, "id" | "name">) => run(device, "reboot"),
		refreshStatus,
		setFavorite,
	};
}
