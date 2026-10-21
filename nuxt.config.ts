// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	compatibilityDate: "2026-09-01",
	devtools: { enabled: true },
	modules: ["@nuxt/ui"],

	colorMode: {
		preference: "dark",
		fallback: "dark",
		classSuffix: "",
	},

	ssr: true,

	css: ["~/assets/css/main.css"],

	app: {
		head: {
			// Installable as an app (PWA): public/manifest.webmanifest, public/sw.js.
			link: [
				{ rel: "manifest", href: "/manifest.webmanifest" },
				{ rel: "apple-touch-icon", href: "/static/pwa/apple-touch-icon.png" },
			],
			meta: [
				{ name: "theme-color", content: "#0b0c1b" },
				{ name: "mobile-web-app-capable", content: "yes" },
				{ name: "apple-mobile-web-app-capable", content: "yes" },
				{ name: "apple-mobile-web-app-title", content: "NetIgnite" },
				{ name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
			],
		},
	},

	vue: {
		compilerOptions: {
			// ESP Web Tools' web component (the ESP32 web installer).
			isCustomElement: (tag) => tag.startsWith("esp-web-") || tag.startsWith("ewt-"),
		},
	},

	nitro: {
		// Agent gateway (server/routes/ws/agent.ts); needs the Bun preset.
		experimental: {
			websocket: true,
		},

		rollupConfig: {
			external: ["bun:sqlite"],

			output: {
				banner: (function () {
					const mappings = {
						NETIGNITE_APP_URL: "APP_URL",
					};

					const bannerCode = `
						(function () {
							const mappings = ${JSON.stringify(mappings)};
							const env = globalThis.process?.env ?? {};
							for (const [envName, runtimeName] of Object.entries(mappings)) {
								if (!env['NUXT_PUBLIC_' + runtimeName] && env[envName]) {
									env['NUXT_PUBLIC_' + runtimeName] = env[envName];
								}
							}
						})();
					`;

					return bannerCode.replace(/^\s+|\s+$/g, "").replace(/\n\s*/g, " ");
				})(),
			},
		},

		esbuild: {
			options: {
				target: "esnext",
			},
		},
	},

	runtimeConfig: {
		public: {
			//@ts-ignore
			appUrl: process.env.NETIGNITE_APP_URL || "http://localhost:18232",
		},
	},

	routeRules: {
		// The public website is netignite.dev; the app starts at the dashboard.
		"/": { redirect: "/dashboard" },
		"/dashboard/**": { ssr: false },
		"/auth/**": { ssr: false },
		"/**": { ssr: true },
	},

	telemetry: false,
});
