/**
 * updateAPIClient — point the generated SDK at the API and set (or clear) the bearer token.
 *
 * `ignoreResponseError: true` means the client never throws on non-2xx; the
 * `{ success, code, message, data }` envelope is always returned and callers branch on
 * `result.success`. `baseURL` is `<appUrl>/api/v1` (or `/api` for unversioned APIs).
 * See docs/05-api-contract.md and docs/07-state-and-data.md.
 */
import { client } from "@/api-client/client.gen";
import { useRuntimeAppConfigs } from "./useRuntimeAppConfigs";

export function updateAPIClient(token: string | null) {
	const appUrl = useRuntimeAppConfigs().appUrl.replace(/\/$/, "");
	const apiURL = `${appUrl}/api/v1`;

	client.setConfig({
		baseURL: apiURL,
		// `null` deletes the header; omitting it would keep the previous token
		headers: { Authorization: token ? `Bearer ${token}` : null },
		ignoreResponseError: true,
	});
}
