/**
 * Registers the service worker (public/sw.js) that makes the dashboard installable as an app.
 * Browsers only allow it on HTTPS pages and localhost.
 */
export default defineNuxtPlugin(() => {
	if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

	const register = () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {
			// Not installable then; the dashboard works the same.
		});
	};
	if (document.readyState === "complete") register();
	else window.addEventListener("load", register, { once: true });
});
