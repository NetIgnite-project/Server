/**
 * useAPI — the single gateway to the generated API SDK.
 *
 * On the server it applies the session cookie's token and calls the SDK; on the client it reads the session cookie,
 * applies it to the generated client via `updateAPIClient`, redirects to `/auth/login` on a missing
 * or 401 token, and always returns the backend's `{ success, code, message, data }` envelope
 * (errors are normalized into the envelope, never thrown). Callers branch on `result.success`.
 * See docs/07-state-and-data.md.
 */
import * as baseAPIClient from "@/api-client/sdk.gen";

export namespace UseAPITypes {
	export type APIClient = typeof baseAPIClient;

	export type DefaultReturn<TReturn> = TReturn;

	export type UseAPIReturnType<TReturn> = Promise<
		| TReturn
		| {
				readonly success: false;
				readonly code: 500;
				readonly message: string;
				readonly data: null;
		  }
	>;

	export type AsyncDataReturn<TReturn> = {
		data: Ref<DefaultReturn<TReturn>>;
		loading: Ref<boolean>;
		refresh: () => Promise<void>;
	};

	export type LazyAsyncDataReturn<TReturn> = {
		data: Ref<DefaultReturn<TReturn>>;
		loading: Ref<boolean>;
		refresh: () => Promise<void>;
	};

	export type AsyncRequestTaskReturn<TReturn> = AsyncRequestTaskWrapper<TReturn>;

	export type LazyAsyncDataRequestReturn<TReturn> = LazyAsyncDataRequestWrapper<TReturn>;
}

class AsyncRequestTaskWrapper<TReturn> {
	readonly loading = ref(false);

	constructor(protected readonly handler: () => Promise<TReturn>) {}

	async execute(): Promise<TReturn> {
		this.loading.value = true;
		try {
			return await this.handler();
		} finally {
			this.loading.value = false;
		}
	}
}

class LazyAsyncDataRequestWrapper<TReturn> {
	// 1. The public read-only refs (computed)
	readonly data: Ref<TReturn | null>;
	readonly loading: Ref<boolean>;

	// 2. Internal pointers (plain class properties, NOT refs themselves)
	protected _activeDataRef: Ref<TReturn | null> | null = null;
	protected _activeLoadingRef: Ref<boolean> | null = null;

	// 3. The "signal" — determines which pointer we are looking at
	protected _linkSignal = ref(0);

	protected refreshFunction?: () => Promise<void>;
	protected clearFunction?: () => void;

	constructor(
		protected readonly name: string,
		protected readonly handler: () => Promise<TReturn>,
		immediateFNInit: boolean,
	) {
		// Initialize the computed properties ONCE
		this.data = computed({
			get: () => {
				this._linkSignal.value;
				return this._activeDataRef?.value ?? null;
			},
			set: (newValue) => {
				if (this._activeDataRef) {
					this._activeDataRef.value = newValue;
				}
			},
		});

		this.loading = computed(() => {
			this._linkSignal.value;
			return this._activeLoadingRef?.value ?? false;
		});

		if (immediateFNInit) {
			this.init();
		}
	}

	public init() {
		// Do not re-run init if already initialized to avoid replacing refs unnecessarily
		if (this.refreshFunction) return;

		const { data, refresh, clear, pending } = useLazyAsyncData<TReturn>(this.name, this.handler, {
			immediate: false,
		});

		this._activeDataRef = data as Ref<TReturn | null>;
		this._activeLoadingRef = pending;

		this.refreshFunction = refresh;
		this.clearFunction = clear;

		// Trigger the signal so the computed properties re-evaluate and find the new refs.
		this._linkSignal.value++;
	}

	async fetchData() {
		if (!this.refreshFunction) {
			this.init();
		}
		if (!this.refreshFunction) {
			throw new Error("Failed to initialize refresh function.");
		}

		await this.refreshFunction();

		return this.data;
	}

	async clearData() {
		this.clearFunction?.();
	}
}

export async function useAPI<TReturn>(
	handler: (api: UseAPITypes.APIClient) => TReturn,
	disableAuthRedirect = false,
): UseAPITypes.UseAPIReturnType<TReturn> {
	try {
		if (import.meta.server) {
			const sessionToken = useAppCookies().sessionToken.get().value;
			updateAPIClient(sessionToken ?? null);
			return await handler(baseAPIClient);
		} else if (import.meta.client) {
			const sessionToken = useAppCookies().sessionToken.get();

			if (sessionToken.value) {
				updateAPIClient(sessionToken.value);
			} else {
				updateAPIClient(null);
				if (!disableAuthRedirect) {
					await navigateTo(`/auth/login?url=${encodeURIComponent(useRoute().fullPath)}`);
				}
			}

			const result = await handler(baseAPIClient);

			if ((result as any)?.success === false && (result as any)?.code === 401) {
				updateAPIClient(null);
				sessionToken.value = null;
				if (!disableAuthRedirect) {
					await navigateTo(`/auth/login?url=${encodeURIComponent(useRoute().fullPath)}`);
				}
			}
			return result;
		} else {
			throw new Error("Unknown environment");
		}
	} catch (error) {
		return {
			success: false,
			code: 500,
			message: (error as Error).message ?? "An unknown error occurred.",
			data: null,
		} as const;
	}
}

export async function useAPIAsyncData<TReturn>(name: string, handler: () => Promise<TReturn>) {
	const { data, pending: loading, refresh } = await useAsyncData<TReturn>(name, handler);

	return {
		data: data as Ref<TReturn>,
		loading,
		refresh,
	} satisfies UseAPITypes.AsyncDataReturn<TReturn>;
}

export async function useAPILazyAsyncData<TReturn>(name: string, handler: () => Promise<TReturn>) {
	const { data, pending: loading, refresh } = await useLazyAsyncData<TReturn>(name, handler);

	return {
		data: data as Ref<TReturn>,
		loading,
		refresh,
	} satisfies UseAPITypes.LazyAsyncDataReturn<TReturn>;
}

export function useAPIAsyncRequestTask<TReturn>(handler: () => Promise<TReturn>) {
	return new AsyncRequestTaskWrapper<TReturn>(
		handler,
	) satisfies UseAPITypes.AsyncRequestTaskReturn<TReturn>;
}

export function useAPILazyAsyncRequest<TReturn>(
	name: string,
	handler: () => Promise<TReturn>,
	immediateFNInit = false,
) {
	return new LazyAsyncDataRequestWrapper<TReturn>(
		name,
		handler,
		immediateFNInit,
	) satisfies UseAPITypes.LazyAsyncDataRequestReturn<TReturn>;
}
