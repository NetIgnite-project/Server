// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    routeRules: {
        '/dashboard': { redirect: '/' }
    },

    ssr: true,

    app: {
        head: {
            charset: "utf-8",
            viewport: "width=device-width, initial-scale=1, maximum-scale=1",
            link: [
                {
                    rel: 'stylesheet',
                    href: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.6/dist/css/bootstrap.min.css'
                },
                { rel: 'stylesheet', href: 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css' },
                { rel: "preconnect", href: "https://fonts.googleapis.com" },
                { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
                { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&display=swap" },

                { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }
            ],
            script: [
                {
                    src: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.6/dist/js/bootstrap.bundle.min.js',
                    tagPosition: 'bodyClose'
                }
            ]

        }
    },

    css: [
        '/assets/css/global.css',
    ],

    // build: {
    //     transpile: ['@libsql/hrana-client', '@libsql/isomorphic-ws']
    // },

    nitro: {
        preset: 'bun',
        experimental: {
            websocket: true
        }
    },

    modules: ['@vite-pwa/nuxt'],

    pwa: {
        registerType: 'autoUpdate',
        manifest: {
            name: 'NetIgnite',
            short_name: 'NetIgnite',
            start_url: '/',
            description: 'NetIgnite - Power On Devices From Anywhere',

            display: 'standalone',
            orientation: 'portrait',

            theme_color: '#ffffff',
            background_color: '#0b0c1b',
        }
    }

});