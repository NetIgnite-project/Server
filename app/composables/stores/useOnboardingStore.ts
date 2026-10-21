/**
 * useOnboardingStore — per-user, backend-persisted flag for the one-time `/welcome` onboarding
 * (`/account/preferences/onboarding`). Drives the first-login redirect in `auth.global.ts`, so
 * `completed` defaults to `false` until the user finishes (or skips) the welcome page.
 */
import { ModifiableAbstractStore } from "~/utils/abstractStore";

export interface OnboardingData {
	completed: boolean;
}

class OnboardingStore extends ModifiableAbstractStore<OnboardingData, Partial<OnboardingData>> {
	private _completed?: ComputedRef<boolean>;

	constructor() {
		super("onboarding", {
			enableAutoFetchIfEmpty: true,
		});
	}

	protected override async fetchData() {
		if (!useAppCookies().sessionToken.get().value) {
			return null;
		}

		const response = await useAPI((api) => api.getAccountPreferencesOnboarding({}), true);
		if (!response.success) {
			return null;
		}

		return { completed: response.data.completed ?? false } satisfies OnboardingData;
	}

	/** Reactive, synchronously readable flag; `false` until the state has loaded. */
	public get completed(): ComputedRef<boolean> {
		this._completed ??= computed(() => this.useRaw().value?.completed ?? false);
		return this._completed;
	}

	/** Updates the local state and persists it to the backend. */
	override async update(updates: Partial<OnboardingData>) {
		await this.refreshIfNeeded();
		const current = this.useRaw();

		const merged: OnboardingData = {
			completed: updates.completed ?? current.value?.completed ?? false,
		};
		current.value = merged;

		const response = await useAPI((api) => api.putAccountPreferencesOnboarding({ body: merged }));
		if (!response.success) {
			throw new Error(response.message || "Failed to save onboarding state.");
		}
	}
}

export function useOnboardingStore() {
	return new OnboardingStore();
}
