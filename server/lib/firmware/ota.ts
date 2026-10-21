import path from "node:path";
import { AgentRequestError } from "../agents/connection";
import { AgentGatewayRunner } from "../agents/gateway";
import { AgentProtocol } from "../agents/protocol";
import { AgentRegistry } from "../agents/registry";
import type { DB } from "../db";
import { Logger } from "../utils/logger";
import { FirmwareCatalog } from "./catalog";

/**
 * OTA updates of ESP32 agents. The server sends `OTA_BEGIN` with the path of a synced firmware
 * image on this server; the agent downloads it with its own credential, verifies and installs it,
 * reports `OTA_PROGRESS` and restarts. The update is done when the agent says HELLO with the new
 * version; a rolled-back update reports the version in `info.ota_failed_version`.
 *
 * Progress is kept in memory: after a server restart, the agent's version tells the outcome.
 */
export class OtaService {
	/** An update that takes longer than this (download, restart, reconnect) counts as failed. */
	static readonly TIMEOUT_MS = 15 * 60 * 1000;
	/** How long finished updates stay visible. */
	static readonly KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;

	private static readonly updates = new Map<number, OtaService.Update>();
	private static initialized = false;

	static init() {
		if (this.initialized) return;
		this.initialized = true;

		AgentGatewayRunner.onEvent("OTA_PROGRESS", (connection, payload) => {
			const event = AgentProtocol.OtaProgressEvent.safeParse(payload);
			if (event.success) this.onProgress(connection.agentID, event.data);
		});
		AgentGatewayRunner.onHello((connection) => {
			if (connection.hello) this.onHello(connection.agentID, connection.hello);
		});
	}

	/** The agent's current or last update, if any. */
	static get(agentID: number): OtaService.Update | null {
		const update = this.updates.get(agentID);
		if (!update) return null;

		const now = Date.now();
		if (OtaService.isRunning(update) && now - update.started_at > this.TIMEOUT_MS) {
			this.finish(agentID, update, "failed", "The update didn't finish in time");
		} else if (!OtaService.isRunning(update) && now - update.updated_at > this.KEEP_FINISHED_MS) {
			this.updates.delete(agentID);
			return null;
		}
		return this.updates.get(agentID) ?? null;
	}

	/** Starts updating an online agent to `release`. Throws {@link OtaError}. */
	static async start(agent: DB.Models.Agent, release: DB.Models.FirmwareRelease) {
		const current = this.get(agent.id);
		if (current && OtaService.isRunning(current) && current.state !== "queued") {
			throw new OtaError("busy", `An update to ${current.version} is already running`);
		}

		const connection = AgentRegistry.get(agent.id);
		if (!connection) throw new OtaError("offline", "The agent is offline");
		if (!connection.hasCapability("ota")) {
			throw new OtaError("unsupported", "This agent's firmware can't be updated over the network");
		}
		if (connection.hello?.version === release.version) {
			throw new OtaError("current", `The agent already runs ${release.version}`);
		}

		const app = release.manifest.parts.find((part) => part.file === release.manifest.app.file);
		if (!app) throw new OtaError("invalid", "The release has no app image");

		let signature: string | undefined;
		if (release.manifest.app.signature) {
			const file = FirmwareCatalog.filePath(release, release.manifest.app.signature);
			const data = file ? Bun.file(file) : null;
			if (data && (await data.exists()))
				signature = Buffer.from(await data.arrayBuffer()).toString("hex");
		}

		const update: OtaService.Update = {
			version: release.version,
			from_version: connection.hello?.version ?? agent.version,
			state: "starting",
			percent: 0,
			error: null,
			started_at: Date.now(),
			updated_at: Date.now(),
		};
		this.updates.set(agent.id, update);

		try {
			await connection.request(
				"OTA_BEGIN",
				{
					version: release.version,
					// Relative to the agent's server URL, which may differ from NETIGNITE_APP_URL.
					path: path.posix.join("/api/v1/firmware", release.version, "files", app.file),
					size: app.size,
					sha256: app.sha256,
					...(signature ? { signature } : {}),
				},
				10_000,
			);
		} catch (error) {
			const message =
				error instanceof AgentRequestError ? error.message : "The agent couldn't start the update";
			this.finish(agent.id, update, "failed", message);
			throw new OtaError("rejected", message);
		}

		if (update.state === "starting") {
			update.state = "downloading";
			update.updated_at = Date.now();
		}
		Logger.info(`Agent ${agent.id}: updating ${update.from_version ?? "?"} → ${release.version}`);
		return update;
	}

	/**
	 * Updates agents one after another in the background: each update has to finish before the
	 * next one starts. Agents that are offline or already current are skipped.
	 */
	static startMany(agents: DB.Models.Agent[], release: DB.Models.FirmwareRelease) {
		for (const agent of agents) {
			this.updates.set(agent.id, {
				version: release.version,
				from_version: agent.version,
				state: "queued",
				percent: 0,
				error: null,
				started_at: Date.now(),
				updated_at: Date.now(),
			});
		}

		void (async () => {
			for (const agent of agents) {
				const queued = this.updates.get(agent.id);
				if (queued?.state !== "queued") continue;
				try {
					await this.start(agent, release);
				} catch (error) {
					const update = this.updates.get(agent.id);
					if (update?.state === "queued" || update?.state === "starting") {
						this.finish(agent.id, update, "failed", (error as Error).message);
					}
					continue;
				}
				await this.waitUntilFinished(agent.id);
			}
		})();
	}

	/** For tests. */
	static reset() {
		this.updates.clear();
	}

	private static async waitUntilFinished(agentID: number) {
		while (true) {
			const update = this.get(agentID);
			if (!update || !OtaService.isRunning(update)) return;
			await Bun.sleep(1000);
		}
	}

	private static onProgress(agentID: number, event: AgentProtocol.OtaProgressEvent) {
		const update = this.updates.get(agentID);
		if (!update || update.version !== event.version || !OtaService.isRunning(update)) return;

		update.updated_at = Date.now();
		if (event.state === "failed") {
			this.finish(agentID, update, "failed", event.error ?? "The agent couldn't install the update");
		} else if (event.state === "installed") {
			update.state = "restarting";
			update.percent = 100;
		} else {
			update.state = "downloading";
			update.percent = event.percent;
		}
	}

	private static onHello(agentID: number, hello: AgentProtocol.Hello) {
		const update = this.updates.get(agentID);
		if (!update || !OtaService.isRunning(update) || update.state === "queued") return;

		if (hello.version === update.version) {
			this.finish(agentID, update, "done", null);
		} else if (hello.info?.ota_failed_version === update.version) {
			this.finish(
				agentID,
				update,
				"failed",
				`The new firmware didn't start correctly; the agent went back to ${hello.version}`,
			);
		} else if (update.state === "restarting") {
			this.finish(agentID, update, "failed", `The agent restarted with ${hello.version}`);
		}
	}

	private static finish(
		agentID: number,
		update: OtaService.Update,
		state: "done" | "failed",
		error: string | null,
	) {
		update.state = state;
		update.error = error;
		update.updated_at = Date.now();
		if (state === "done") update.percent = 100;
		Logger.info(
			`Agent ${agentID}: update to ${update.version} ${state}${error ? ` (${error})` : ""}`,
		);
	}

	static isRunning(update: OtaService.Update) {
		return update.state !== "done" && update.state !== "failed";
	}
}

export namespace OtaService {
	export interface Update {
		version: string;
		from_version: string | null;
		/**
		 * `queued` (bulk update) → `starting` → `downloading` → `restarting` → `done` | `failed`.
		 */
		state: "queued" | "starting" | "downloading" | "restarting" | "done" | "failed";
		percent: number;
		error: string | null;
		started_at: number;
		updated_at: number;
	}
}

export class OtaError extends Error {
	constructor(
		readonly reason: "busy" | "offline" | "unsupported" | "current" | "invalid" | "rejected",
		message: string,
	) {
		super(message);
	}
}
