import { existsSync, mkdirSync, rmSync } from "fs";
import { API } from "../server/lib/api";

if (!existsSync("./data/")) {
	mkdirSync("./data/");
}

try {
	await API.init([], false);

	const res = await API.getApp().request("/docs/v1/openapi");
	if (!res.ok) {
		console.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
		process.exit(1);
	}

	await Bun.write("./data/temp-api-openapi.json", res);

	await Bun.$`bunx openapi-ts`;
	await Bun.$`bun scripts/patch-api-client.ts`;

	rmSync("./data/temp-api-openapi.json", { force: true });
} catch (err: any) {
	console.error("[api-client-generate] Failed to generate OpenAPI spec:", err);
	rmSync("./data/temp-api-openapi.json", { force: true });
	process.exit(1);
}
