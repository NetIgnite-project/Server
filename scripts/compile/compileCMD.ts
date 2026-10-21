/**
 * The compile CLI commands, built on @cleverjs/cli.
 *
 *   bun run compile auto 1.2.3            → build for the host platform
 *   bun run compile linux-x64-baseline 1.2.3 --no-version-tag
 *   bun run compile all 1.2.3             → build every platform
 *
 * `--no-version-tag` omits the `-v<version>` suffix from the outfile (used by CI which tags
 * images separately). See docs/11-cli-and-infra.md and docs/14-deployment.md.
 */
import {
	CLIBaseCommand,
	CLICommandArg,
	type CLICommandArgParser,
	type CLICommandContext,
} from "@cleverjs/cli";
import { Compiler, type PlatformArg, Platforms } from "./compiler";

class CompileUtils {
	static async getPackageJSONVersion() {
		try {
			const packageJSON = (await Bun.file(`${process.cwd()}/package.json`).json()) as {
				version: string;
			};
			return packageJSON.version;
		} catch (err: any) {
			console.log(`Error reading package.json: ${err.stack}`);
			process.exit(1);
		}
	}

	static async getTargetVersion(args: Array<string | undefined>): Promise<[string, boolean]> {
		if (args[0] === "--no-version-tag") {
			const version = await CompileUtils.getPackageJSONVersion();
			return [version, false];
		}
		const argvVersion = args[0] || process.env.APP_TARGET_VERSION;
		const version = argvVersion || (await CompileUtils.getPackageJSONVersion());

		if (!version) {
			console.log("No version specified. Please specify a version.");
			process.exit(1);
		}

		const versionInFileName = args[1] !== "--no-version-tag";
		return [version, versionInFileName];
	}
}

const CMD_ARG_SPEC = CLICommandArg.defineCLIArgSpecs({
	args: [
		{
			name: "all",
			variadic: true,
			description: "Args",
			type: "string",
		},
	],
});

export class CompileAllCMD extends CLIBaseCommand<typeof CMD_ARG_SPEC> {
	constructor() {
		super({
			name: "all",
			description: "Compile for all platforms",
			args: CMD_ARG_SPEC,
		});
	}

	override async run(
		args: CLICommandArgParser.ParsedArgs<typeof CMD_ARG_SPEC>,
		_ctx: CLICommandContext,
	): Promise<boolean> {
		const builds: Promise<void>[] = [];
		const versionSettings = await CompileUtils.getTargetVersion(args.args.all);

		for (const platform in Platforms) {
			builds.push(new Compiler(platform as PlatformArg, ...versionSettings).build());
		}
		await Promise.all(builds);

		return true;
	}
}

export class CompileToTargetCMD extends CLIBaseCommand<typeof CMD_ARG_SPEC> {
	readonly usage = "[<platform> | auto | all] [<version>] [--no-version-tag]";

	constructor() {
		super({
			name: "auto",
			description: "Compile for a specified platform",
			aliases: Object.keys(Platforms),
			args: CMD_ARG_SPEC,
		});
	}

	override async run(
		args: CLICommandArgParser.ParsedArgs<typeof CMD_ARG_SPEC>,
		ctx: CLICommandContext,
	): Promise<boolean> {
		const platform = (ctx.raw_parent_args.at(-1) || "auto") as PlatformArg;

		if (!Object.keys(Platforms).some((p) => p === platform) && platform !== "auto") {
			console.log(`Invalid platform: ${platform}`);
			return false;
		}
		const versionSettings = await CompileUtils.getTargetVersion(args.args.all);
		await new Compiler(platform, ...versionSettings).build();

		return true;
	}
}
