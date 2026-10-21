/**
 * useAppCookies — typed session-cookie accessor.
 *
 * `AppCookie` wraps `useCookie` so callers do `useAppCookies().sessionToken.get().value` /
 * `.set(value, options?)`. The cookie name uses the project's `<PREFIX>` (e.g.
 * `dla_session_token`, `mindcode_session_token`) — keep it in sync with the backend's token
 * prefix. The session cookie defaults to `secure; sameSite=lax; httpOnly=false` so the client
 * can read it to feed `updateAPIClient` (see docs/10-auth.md#frontend-session-handling).
 */
import type { CookieOptions } from "#app";

type CookieOptionsWithoutReadonly<T> = CookieOptions<T> & {
	readonly?: false;
};

const SESSION_COOKIE_OPTIONS: CookieOptionsWithoutReadonly<string | null> = {
	path: "/",
	secure: true, // allowed on localhost; required in prod
	sameSite: "lax",
	httpOnly: false, // the client must read the token to attach it to the SDK
};

class AppCookie<T extends string | null | undefined> {
	constructor(
		protected readonly name: string,
		protected readonly options?: CookieOptionsWithoutReadonly<T>,
	) {}

	get() {
		return useCookie(this.name);
	}

	set(value: T, options?: CookieOptionsWithoutReadonly<T>) {
		const merged = { ...this.options, ...options } as CookieOptionsWithoutReadonly<T> | undefined;
		useCookie(this.name, merged).value = value;
	}
}

export function useAppCookies() {
	return {
		// Replace <PREFIX> with your project's prefix (e.g. dla_, nowip_, mindcode_).
		sessionToken: new AppCookie<string | null>("netignite_session_token", SESSION_COOKIE_OPTIONS),
	} as const;
}
