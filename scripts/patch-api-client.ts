/**
 * Post-generation patch for `app/api-client` (see docs/05-api-contract.md › patch-api-client.ts).
 *
 * `@hey-api/client-nuxt` emits code whose internal generics do not line up with Nuxt 4.5's
 * `useFetch`/`RequestResult` types, which fails `nuxt typecheck` although the runtime code and the
 * public SDK signatures are fine. The affected generated files get `// @ts-nocheck`; callers keep
 * their full types. Idempotent — runs after every `openapi-ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILES = ["app/api-client/sdk.gen.ts", "app/api-client/client/client.gen.ts"];
const MARKER = "// @ts-nocheck — patched by scripts/patch-api-client.ts\n";

for (const file of FILES) {
	const source = readFileSync(file, "utf8");
	if (source.startsWith(MARKER)) continue;
	writeFileSync(file, MARKER + source);
	console.log(`[patch-api-client] patched ${file}`);
}
