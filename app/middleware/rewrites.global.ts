/**
 * rewrites.global.ts — strip trailing slashes (except on `/`).
 *
 * Drop into `app/middleware/rewrites.global.ts`. Nuxt route middleware runs on every navigation.
 */
export default defineNuxtRouteMiddleware((to) => {
	if (to.path.endsWith("/") && to.path !== "/") {
		return navigateTo(to.path.slice(0, -1), { replace: true });
	}
});
