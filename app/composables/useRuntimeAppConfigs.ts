/**
 * useRuntimeAppConfigs — typed access to publicRuntimeConfig.
 *
 * The template exposes `apiUrl` and `appUrl` from `nuxt.config.ts` under `publicRuntimeConfig`.
 * This composable wraps them with safe fallbacks for SSR and client.
 * See docs/05-api-contract.md and docs/07-state-and-data.md.
 */
export function useRuntimeAppConfigs() {
	const config = useRuntimeConfig();
	return {
		apiUrl: (config.public.apiUrl as string | undefined) ?? "",
		appUrl: (config.public.appUrl as string | undefined) ?? "",
	} as const;
}
