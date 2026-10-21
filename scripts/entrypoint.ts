/**
 * Compiled-binary entrypoint — `bun run scripts/entrypoint.ts` (and the binary's
 * ENTRYPOINT). Enables DB auto-migration on cold start, then starts the built Nitro server
 * (`.output/server/index.mjs` — run `bun run build` first). See docs/14-deployment.md.
 */
process.env.NETIGNITE_DB_AUTO_MIGRATE = "true";

await import("../.output/server/index.mjs");

export {};
