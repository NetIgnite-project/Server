import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
	input: "./data/temp-api-openapi.json",
	output: "app/api-client",
	plugins: ["@hey-api/client-nuxt", "@hey-api/typescript", "@hey-api/sdk", "zod"],
});
