import { ControllableAgent } from "../agent-control-service/agent";
import fs from "fs";
import { Logger } from "./logger";

export interface ConfigLike {
	logLevel?: Logger.LogLevel;
	//agents: ControllableAgent.IConfig[];
}

export class ConfigHandler {

	private static readonly configFilePath = process.env.CONFIG_FILE_PATH || './config/config.json';
	private static readonly sampleConfigFilePath = './config/config.sample.json';

	private static config: ConfigLike | null = null;

	static async getConfig(): Promise<ConfigLike | null> {
		return this.config;
	}

	static async loadConfig() {

		// Check if the config is already loaded
		if (this.config) return this.config;

		try {

			if (!fs.existsSync(this.configFilePath)) {
				// If config file does not exist, create it from sample
				if (fs.existsSync(this.sampleConfigFilePath)) {
					fs.copyFileSync(this.sampleConfigFilePath, this.configFilePath);
				} else {
					console.error("Could not find config file or sample config file.");
					process.exit(1);
				}
			}

			// Load the config from config file is not already loaded
			const configFile = fs.readFileSync(this.configFilePath, 'utf-8');
			this.config = JSON.parse(configFile) as ConfigLike;
			
			// this.config = await Bun.file(this.configFilePath).json() as ConfigLike;
			return this.config;

		} catch (error) {
			console.error("Error loading config file:", error);
			process.exit(1);
		}
	}

}
