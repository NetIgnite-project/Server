import { createHash, randomBytes, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RuntimeMetadata } from "../api/utils/metadata";
import { FirmwareSettings } from "../api/utils/shared-models/netigniteData";
import { DB } from "../db";
import { Logger } from "../utils/logger";

/**
 * ESP32 firmware releases for the web installer and OTA updates.
 *
 * `sync()` reads the GitHub releases of the Agent-ESP32 repository, downloads the files listed in
 * each release's `release.json`, checks their size and SHA-256 (and `firmware.sig` when a public
 * key is configured) and keeps the newest releases in `<dir>/<version>/`. Firmware only ever comes
 * from these releases; there are no uploads.
 */
export class FirmwareCatalog {
	/** Releases kept locally; the newest stable release is kept in addition. */
	static readonly KEEP_RELEASES = 5;
	static readonly MAX_FILE_SIZE = 4 * 1024 * 1024;
	/** The agent protocol this server speaks; releases for another one are skipped. */
	static readonly PROTOCOL = 2;

	protected static source: FirmwareCatalog.Source | null = null;
	protected static running: Promise<FirmwareCatalog.SyncResult> | null = null;

	static async configure(source: FirmwareCatalog.SourceOptions) {
		this.source = {
			...source,
			apiURL: source.apiURL.replace(/\/$/, ""),
			publicKey: source.publicKeyPath ? await Bun.file(source.publicKeyPath).text() : null,
		};
	}

	static get configured() {
		return this.source !== null;
	}

	/** Releases, newest first. */
	static async list() {
		const releases = await DB.instance()
			.select()
			.from(DB.Tables.firmwareReleases)
			.orderBy(desc(DB.Tables.firmwareReleases.published_at));
		return releases.sort((a, b) => Bun.semver.order(b.version, a.version));
	}

	static async get(version: string) {
		return (
			(await DB.instance()
				.select()
				.from(DB.Tables.firmwareReleases)
				.where(eq(DB.Tables.firmwareReleases.version, version))
				.get()) ?? null
		);
	}

	/** The newest release of the channel, or null. */
	static recommended(releases: DB.Models.FirmwareRelease[], channel: FirmwareSettings.Channel) {
		return releases.find((release) => channel === "prerelease" || !release.prerelease) ?? null;
	}

	/** The newest release of the admin's channel, or null. */
	static async recommendedRelease() {
		const { firmware_channel } = await RuntimeMetadata.getSettings();
		return this.recommended(await this.list(), firmware_channel);
	}

	/** Whether `version` is newer than the agent's `current` version (semver; unknown counts as older). */
	static isNewer(version: string, current: string | null) {
		if (!current) return true;
		try {
			return Bun.semver.order(version, current) > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Path of a file of a synced release: one of its flash images or its signature. Null if the
	 * release or file is unknown.
	 */
	static filePath(release: DB.Models.FirmwareRelease, file: string) {
		const known =
			release.manifest.parts.some((part) => part.file === file) ||
			release.manifest.app.signature === file;
		if (!known || !this.source) return null;
		return path.join(this.source.dir, release.version, file);
	}

	/** Runs a sync, or joins the one already running. Never throws; see the result's `error`. */
	static sync() {
		this.running ??= this.runSync().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	protected static async runSync(): Promise<FirmwareCatalog.SyncResult> {
		const source = this.source;
		const state = await RuntimeMetadata.getFirmwareSyncState();
		const startedAt = Date.now();

		if (!source) {
			return { added: [], removed: [], skipped: [], error: "The firmware catalog isn't configured" };
		}

		try {
			const result = await this.syncFrom(source);
			await RuntimeMetadata.setFirmwareSyncState({
				last_run_at: startedAt,
				last_success_at: startedAt,
				error: null,
			});
			if (result.added.length > 0 || result.removed.length > 0) {
				Logger.info(
					`Firmware sync: added ${result.added.join(", ") || "none"}, removed ${result.removed.join(", ") || "none"}`,
				);
			}
			for (const skipped of result.skipped) {
				Logger.warn(`Firmware sync: skipped ${skipped.version}: ${skipped.reason}`);
			}
			return result;
		} catch (error) {
			const message = Error.isError(error) ? error.message : String(error);
			Logger.warn(`Firmware sync failed: ${message}`);
			await RuntimeMetadata.setFirmwareSyncState({ ...state, last_run_at: startedAt, error: message });
			return { added: [], removed: [], skipped: [], error: message };
		}
	}

	protected static async syncFrom(
		source: FirmwareCatalog.Source,
	): Promise<FirmwareCatalog.SyncResult> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "NetIgnite-Server",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (source.token) headers.Authorization = `Bearer ${source.token}`;

		const response = await fetch(`${source.apiURL}/repos/${source.repo}/releases?per_page=30`, {
			headers,
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`GitHub answered ${response.status} for the releases of ${source.repo}`);
		}
		const releases = z.array(GitHubRelease).parse(await response.json());

		const candidates = releases
			.filter((release) => !release.draft)
			.map((release) => ({ release, version: release.tag_name.replace(/^v/, "") }))
			.filter(
				({ release, version }) =>
					FirmwareSettings.Version.safeParse(version).success &&
					release.assets.some((asset) => asset.name === "release.json"),
			)
			.sort((a, b) => Bun.semver.order(b.version, a.version));

		const keep = candidates.slice(0, this.KEEP_RELEASES);
		const newestStable = candidates.find(({ release }) => !release.prerelease);
		if (newestStable && !keep.includes(newestStable)) keep.push(newestStable);

		const result: FirmwareCatalog.SyncResult = { added: [], removed: [], skipped: [], error: null };
		const stored = new Map((await this.list()).map((release) => [release.version, release]));

		for (const { release, version } of keep) {
			const existing = stored.get(version);
			if (existing && (await this.filesPresent(source, existing))) {
				if (existing.prerelease !== release.prerelease) {
					await DB.instance()
						.update(DB.Tables.firmwareReleases)
						.set({ prerelease: release.prerelease })
						.where(eq(DB.Tables.firmwareReleases.version, version));
				}
				continue;
			}

			try {
				await this.download(source, release, version);
				result.added.push(version);
			} catch (error) {
				result.skipped.push({ version, reason: Error.isError(error) ? error.message : String(error) });
			}
		}

		// Releases that are no longer among the newest (or were deleted on GitHub).
		const kept = new Set(keep.map(({ version }) => version));
		for (const version of stored.keys()) {
			if (kept.has(version)) continue;
			await DB.instance()
				.delete(DB.Tables.firmwareReleases)
				.where(eq(DB.Tables.firmwareReleases.version, version));
			result.removed.push(version);
		}
		await this.removeStaleDirectories(source, kept);

		return result;
	}

	protected static async download(
		source: FirmwareCatalog.Source,
		release: z.infer<typeof GitHubRelease>,
		version: string,
	) {
		const asset = (name: string) => {
			const found = release.assets.find((a) => a.name === name);
			if (!found) throw new Error(`the release has no ${name}`);
			return found;
		};

		const manifestData = await this.fetchFile(asset("release.json"), 64 * 1024);
		const parsed = FirmwareSettings.Manifest.safeParse(
			JSON.parse(new TextDecoder().decode(manifestData)),
		);
		if (!parsed.success) {
			throw new Error(`invalid release.json: ${parsed.error.issues[0]?.message}`);
		}
		const manifest = parsed.data;
		if (manifest.version !== version) {
			throw new Error(`release.json is for version ${manifest.version}`);
		}
		if (manifest.protocol !== this.PROTOCOL) {
			throw new Error(`the firmware speaks agent protocol ${manifest.protocol}, not ${this.PROTOCOL}`);
		}
		if (!manifest.parts.some((part) => part.file === manifest.app.file)) {
			throw new Error("release.json doesn't list the app image as a part");
		}

		const incoming = path.join(source.dir, `.incoming-${version}-${randomBytes(4).toString("hex")}`);
		await fs.mkdir(incoming, { recursive: true });

		try {
			const files = new Map<string, Uint8Array>();
			for (const part of manifest.parts) {
				const data = await this.fetchFile(asset(part.file), this.MAX_FILE_SIZE);
				if (data.length !== part.size) {
					throw new Error(`${part.file} has ${data.length} bytes, release.json says ${part.size}`);
				}
				if (createHash("sha256").update(data).digest("hex") !== part.sha256) {
					throw new Error(`${part.file} doesn't match its SHA-256`);
				}
				files.set(part.file, data);
			}

			let signatureVerified = false;
			if (manifest.app.signature) {
				const signature = await this.fetchFile(asset(manifest.app.signature), 1024);
				files.set(manifest.app.signature, signature);
				if (source.publicKey) {
					const app = files.get(manifest.app.file) as Uint8Array;
					if (!verify("sha256", app, source.publicKey, signature)) {
						throw new Error("the firmware signature is invalid");
					}
					signatureVerified = true;
				}
			}
			if (source.publicKey && !signatureVerified) {
				throw new Error("the release isn't signed, but FIRMWARE_PUBLIC_KEY requires a signature");
			}

			for (const [name, data] of files) {
				await Bun.write(path.join(incoming, name), data);
			}
			await Bun.write(path.join(incoming, "release.json"), manifestData);

			const target = path.join(source.dir, version);
			await fs.rm(target, { recursive: true, force: true });
			await fs.rename(incoming, target);

			const row = {
				version,
				prerelease: release.prerelease,
				published_at: Date.parse(release.published_at ?? release.created_at) || Date.now(),
				release_url: release.html_url,
				notes: (release.body ?? "").slice(0, 20_000),
				manifest,
				signature_verified: signatureVerified,
			};
			await DB.instance()
				.insert(DB.Tables.firmwareReleases)
				.values(row)
				.onConflictDoUpdate({ target: DB.Tables.firmwareReleases.version, set: row });
		} finally {
			await fs.rm(incoming, { recursive: true, force: true });
		}
	}

	/** Downloads a release asset (public repositories: no token, GitHub redirects to its CDN). */
	protected static async fetchFile(
		asset: { name: string; browser_download_url: string },
		maxBytes: number,
	) {
		const response = await fetch(asset.browser_download_url, {
			headers: { "User-Agent": "NetIgnite-Server" },
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) throw new Error(`downloading ${asset.name} failed with ${response.status}`);
		if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
			throw new Error(`${asset.name} is too large`);
		}
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.length > maxBytes) throw new Error(`${asset.name} is too large`);
		return data;
	}

	protected static async filesPresent(
		source: FirmwareCatalog.Source,
		release: DB.Models.FirmwareRelease,
	) {
		for (const part of release.manifest.parts) {
			const file = Bun.file(path.join(source.dir, release.version, part.file));
			if (!(await file.exists()) || file.size !== part.size) return false;
		}
		return true;
	}

	/**
	 * Deletes version directories that aren't kept and leftovers of interrupted downloads. Only one
	 * sync runs at a time, so no download is in progress here.
	 */
	protected static async removeStaleDirectories(source: FirmwareCatalog.Source, kept: Set<string>) {
		let entries: string[];
		try {
			entries = await fs.readdir(source.dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const stale =
				entry.startsWith(".incoming-") ||
				(FirmwareSettings.Version.safeParse(entry).success && !kept.has(entry));
			if (stale) await fs.rm(path.join(source.dir, entry), { recursive: true, force: true });
		}
	}
}

export namespace FirmwareCatalog {
	export interface SourceOptions {
		/** `owner/name` of the GitHub repository. */
		repo: string;
		/** `https://api.github.com`, or a test server. */
		apiURL: string;
		dir: string;
		publicKeyPath: string | null;
		token: string | null;
	}

	export interface Source extends Omit<SourceOptions, "publicKeyPath"> {
		publicKey: string | null;
	}

	export interface SyncResult {
		added: string[];
		removed: string[];
		skipped: { version: string; reason: string }[];
		error: string | null;
	}
}

const GitHubRelease = z.object({
	tag_name: z.string(),
	html_url: z.string(),
	body: z.string().nullable().optional(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	created_at: z.string(),
	published_at: z.string().nullable(),
	assets: z.array(
		z.object({
			name: z.string(),
			size: z.number(),
			browser_download_url: z.string(),
		}),
	),
});
