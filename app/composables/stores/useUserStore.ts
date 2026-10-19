/**
 * useUserInfoStore — the signed-in user's account (`GET /account`), cached in `useState`.
 *
 * Auto-fetches on the first `use()` and resolves to `null` without a valid session. `useAPI` runs
 * with the auth redirect disabled so `auth.global.ts` decides where to send the user. Call
 * `clear()` on logout. See docs/07-state-and-data.md.
 */
import { ModifiableAbstractStore } from "~/utils/abstractStore";
import type { UserInfo } from "~/utils/types";

class UserInfoStore extends ModifiableAbstractStore<UserInfo, Partial<UserInfo>> {
	constructor() {
		super("userInfo", {
			enableAutoFetchIfEmpty: true,
		});
	}

	protected override async fetchData() {
		if (!useAppCookies().sessionToken.get().value) {
			return null;
		}

		const response = await useAPI((api) => api.getAccount({}), true);
		if (!response.success) {
			return null;
		}

		return response.data satisfies UserInfo;
	}

	override async update(updates: Partial<UserInfo>) {
		await this.refreshIfNeeded();
		const current = this.useRaw();

		if (!current.value) {
			console.error("Cannot update user info: no user is logged in.");
			return;
		}

		current.value = {
			...current.value,
			...updates,
		};
	}
}

export function useUserInfoStore() {
	return new UserInfoStore();
}
