import { existsSync, mkdirSync } from "node:fs";

if (!existsSync("./data/")) {
	mkdirSync("./data/");
}
