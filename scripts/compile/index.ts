/**
 * The `compile` script entrypoint — `bun run ./scripts/compile`.
 * Wires the compile CLI (built on @cleverjs/cli) and dispatches to CompileToTargetCMD /
 * CompileAllCMD. See docs/11-cli-and-infra.md.
 */
import { CLIApp } from "@cleverjs/cli";
import { CompileAllCMD, CompileToTargetCMD } from "./compileCMD";
import { Platforms } from "./compiler";

class CompileCMD extends CLIApp {
	protected async run_help(): Promise<void> {
		console.log("Usage: bun compile [<platform> | auto | all] [<version>] [--no-version-tag]");
		console.log(`Platforms: ${Object.keys(Platforms).join(", ")}`);
	}
}

await new CompileCMD()
	.register(new CompileToTargetCMD())
	.register(new CompileAllCMD())
	.handle(process.argv.slice(2), "shell");
