import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename } from "node:path";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import {
	fetchUpdateCheck,
	updateCheckFailed,
} from "@ryuhq/core-client/updates";
import { z } from "zod";
import { VERSION } from "../cli/version.ts";

const AUTO_UPDATE_PREFERENCE = "auto-updates";
const RELEASE_REPOSITORY = "amajorai/ryu";
const MAX_CLI_ASSET_BYTES = 256 * 1024 * 1024;
const API_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export const autoUpdatePreferenceSchema = z.object({
	value: z.string().nullable().catch(null),
});
export const autoUpdateSettingSchema = z.union([
	z.object({ enabled: z.boolean().catch(true) }),
	z
		.union([z.string(), z.number(), z.boolean(), z.array(z.json())])
		.transform(() => ({ enabled: true })),
]);
const stagedCliUpdateSchema = z.object({
	asset: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
	version: z.string().refine((version) => parseVersion(version) !== null),
});
type StagedCliUpdate = z.infer<typeof stagedCliUpdateSchema>;
const updateLockSchema = z.object({ pid: z.number().int().positive() });
const fileErrorSchema = z.object({ code: z.string() });

export type CliAutoUpdateResult =
	| { status: "disabled" | "not-applicable" | "current" | "unavailable" }
	| { status: "installed" | "pending-exit"; version: string };

function releaseChannel(version: string): string {
	const match = /-(beta|canary|nightly)(?:[.+-]|$)/u.exec(version);
	return match?.[1] ?? "stable";
}

interface ParsedVersion {
	major: bigint;
	minor: bigint;
	patch: bigint;
	prerelease: string[] | null;
}

function parseVersion(raw: string): ParsedVersion | null {
	const match =
		/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
			raw.trim()
		);
	if (!match) {
		return null;
	}
	const prerelease = match[4]?.split(".") ?? null;
	if (prerelease?.some((part) => part.length === 0 || /^0\d+$/u.test(part))) {
		return null;
	}
	return {
		major: BigInt(match[1] ?? "0"),
		minor: BigInt(match[2] ?? "0"),
		patch: BigInt(match[3] ?? "0"),
		prerelease,
	};
}

function compareVersionIdentifiers(left: string, right: string): number {
	const leftNumeric = /^\d+$/u.test(left);
	const rightNumeric = /^\d+$/u.test(right);
	if (leftNumeric && rightNumeric) {
		const leftValue = BigInt(left);
		const rightValue = BigInt(right);
		return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
	}
	if (leftNumeric !== rightNumeric) {
		return leftNumeric ? -1 : 1;
	}
	return left < right ? -1 : left > right ? 1 : 0;
}

export function isNewerCliVersion(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	const installed = parseVersion(current);
	if (!(next && installed)) {
		return false;
	}
	for (const key of ["major", "minor", "patch"] as const) {
		if (next[key] !== installed[key]) {
			return next[key] > installed[key];
		}
	}
	if (next.prerelease === null || installed.prerelease === null) {
		return next.prerelease === null && installed.prerelease !== null;
	}
	const identifierCount = Math.max(
		next.prerelease.length,
		installed.prerelease.length
	);
	for (let index = 0; index < identifierCount; index += 1) {
		const nextPart = next.prerelease[index];
		const currentPart = installed.prerelease[index];
		if (nextPart === undefined || currentPart === undefined) {
			return nextPart !== undefined;
		}
		const order = compareVersionIdentifiers(nextPart, currentPart);
		if (order !== 0) {
			return order > 0;
		}
	}
	return false;
}

function releaseTagMatchesVersion(
	tag: string,
	version: string,
	channel: string
): boolean {
	if ((channel === "nightly" || channel === "canary") && tag === channel) {
		return true;
	}
	return (
		parseVersion(tag) !== null &&
		!isNewerCliVersion(tag, version) &&
		!isNewerCliVersion(version, tag)
	);
}

function cliAssetName(platform: NodeJS.Platform, arch: string): string | null {
	if (platform === "darwin" && arch === "arm64") {
		return "ryu-cli-macos-aarch64";
	}
	if (platform === "linux" && arch === "x64") {
		return "ryu-cli-linux-x86_64";
	}
	if (platform === "win32" && arch === "x64") {
		return "ryu-cli-windows-x86_64.exe";
	}
	return null;
}

function isCompiledCliExecutable(path: string): boolean {
	return /^ryu-cli(?:\.exe)?$/iu.test(basename(path));
}

async function autoUpdatesEnabled(target: ApiTarget): Promise<boolean> {
	try {
		const response = await fetchForTarget(target)(
			apiUrl(target, `/api/preferences/${AUTO_UPDATE_PREFERENCE}`),
			{
				headers: makeHeaders(target.token, target.userJwt),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			}
		);
		if (!response.ok) {
			return response.status === 404;
		}
		const wire = autoUpdatePreferenceSchema.parse(await response.json());
		if (wire.value === null) {
			return true;
		}
		return autoUpdateSettingSchema.parse(JSON.parse(wire.value)).enabled;
	} catch {
		// Launch still proceeds, but an unreadable preference must not override opt-out.
		return false;
	}
}

function validReleaseTag(tag: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(tag) && !tag.includes("..")
	);
}

/** Parse a published `<asset>.sha256` body; null unless it names `asset` (or no file). */
export function checksumFromText(raw: string, asset: string): string | null {
	const [hash, filename] = raw.trim().split(/\s+/u, 2);
	if (!(hash && /^[a-f0-9]{64}$/iu.test(hash))) {
		return null;
	}
	if (filename && filename.replace(/^\*/u, "") !== asset) {
		return null;
	}
	return hash.toLowerCase();
}

async function removeStagedUpdate(stagedPath: string, metadataPath: string) {
	await Promise.all([
		rm(stagedPath, { force: true }),
		rm(metadataPath, { force: true }),
	]);
}

async function scheduleWindowsReplacement(
	executablePath: string,
	stagedPath: string,
	metadataPath: string
): Promise<boolean> {
	const scriptPath = `${executablePath}.update-${process.pid}.ps1`;
	const script = `param([string]$Target,[string]$Staged,[string]$Metadata,[string]$ScriptPath,[int]$ParentPid)
$ErrorActionPreference = 'Stop'
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }
$Deadline = (Get-Date).AddMinutes(10)
while ($true) {
  try { Move-Item -LiteralPath $Staged -Destination $Target -Force; break }
  catch {
    if ((Get-Date) -ge $Deadline) { Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue; exit 1 }
    Start-Sleep -Seconds 2
  }
}
Remove-Item -LiteralPath $Metadata -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ScriptPath -Force -ErrorAction SilentlyContinue
`;
	await writeFile(scriptPath, script, { mode: 0o600 });
	try {
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-WindowStyle",
				"Hidden",
				"-File",
				scriptPath,
				executablePath,
				stagedPath,
				metadataPath,
				scriptPath,
				String(process.pid),
			],
			{ detached: true, stdio: "ignore", windowsHide: true }
		);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", reject);
		});
		child.unref();
		return true;
	} catch {
		await rm(scriptPath, { force: true });
		return false;
	}
}

async function applyStagedUpdate(
	executablePath: string,
	currentVersion: string,
	asset: string,
	platform: NodeJS.Platform
): Promise<Extract<
	CliAutoUpdateResult,
	{ status: "installed" | "pending-exit" }
> | null> {
	const stagedPath = `${executablePath}.update`;
	const metadataPath = `${stagedPath}.json`;
	try {
		const metadata = stagedCliUpdateSchema.safeParse(
			JSON.parse(await readFile(metadataPath, "utf8"))
		);
		if (!metadata.success || metadata.data.asset !== asset) {
			await removeStagedUpdate(stagedPath, metadataPath);
			return null;
		}
		const parsed = metadata.data;
		if (!isNewerCliVersion(parsed.version, currentVersion)) {
			await removeStagedUpdate(stagedPath, metadataPath);
			return null;
		}
		const bytes = await readFile(stagedPath);
		const actualHash = createHash("sha256").update(bytes).digest("hex");
		if (actualHash !== parsed.sha256) {
			await removeStagedUpdate(stagedPath, metadataPath);
			return null;
		}
		const executable = await stat(executablePath);
		await chmod(stagedPath, executable.mode & 0o777);
		if (platform === "win32") {
			if (
				!(await scheduleWindowsReplacement(
					executablePath,
					stagedPath,
					metadataPath
				))
			) {
				return null;
			}
			return { status: "pending-exit", version: parsed.version };
		}
		await rename(stagedPath, executablePath);
		await rm(metadataPath, { force: true });
		return { status: "installed", version: parsed.version };
	} catch {
		return null;
	}
}

async function stageReleaseAsset(
	executablePath: string,
	asset: string,
	tag: string,
	version: string,
	fetcher: typeof fetch
): Promise<boolean> {
	const releaseBase = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
	const assetUrl = `${releaseBase}/${encodeURIComponent(asset)}`;
	try {
		const [checksumResponse, assetResponse] = await Promise.all([
			fetcher(`${assetUrl}.sha256`, {
				signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			}),
			fetcher(assetUrl, {
				signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			}),
		]);
		if (!(checksumResponse.ok && assetResponse.ok)) {
			return false;
		}
		const expectedHash = checksumFromText(await checksumResponse.text(), asset);
		const contentLength = Number(assetResponse.headers.get("content-length"));
		if (
			!expectedHash ||
			(Number.isFinite(contentLength) && contentLength > MAX_CLI_ASSET_BYTES)
		) {
			return false;
		}
		const bytes = Buffer.from(await assetResponse.arrayBuffer());
		if (
			bytes.byteLength === 0 ||
			bytes.byteLength > MAX_CLI_ASSET_BYTES ||
			createHash("sha256").update(bytes).digest("hex") !== expectedHash
		) {
			return false;
		}
		const executable = await stat(executablePath);
		const stagedPath = `${executablePath}.update`;
		const metadataPath = `${stagedPath}.json`;
		const nonce = `${process.pid}-${randomUUID()}`;
		const binaryTemp = `${stagedPath}.${nonce}.tmp`;
		const metadataTemp = `${metadataPath}.${nonce}.tmp`;
		try {
			await writeFile(binaryTemp, bytes, { mode: executable.mode & 0o777 });
			await chmod(binaryTemp, executable.mode & 0o777);
			await writeFile(
				metadataTemp,
				JSON.stringify({
					asset,
					sha256: expectedHash,
					version,
				} satisfies StagedCliUpdate),
				{ mode: 0o600 }
			);
			await rename(binaryTemp, stagedPath);
			await rename(metadataTemp, metadataPath);
			return true;
		} catch {
			await Promise.all([
				rm(binaryTemp, { force: true }),
				rm(metadataTemp, { force: true }),
			]);
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Apply any previously verified release and prepare the next CLI release in the
 * background. The running TUI is never interrupted; a prepared binary replaces
 * the installed executable for the next launch. Development/source runs skip
 * this path, and the shared Core `auto-updates` preference controls it.
 */
export interface CliAutoUpdateOptions {
	arch?: string;
	executablePath?: string;
	fetcher?: typeof fetch;
	platform?: NodeJS.Platform;
	version?: string;
}

export async function runCliAutoUpdate(
	target: ApiTarget,
	options: CliAutoUpdateOptions = {}
): Promise<CliAutoUpdateResult> {
	const executablePath = options.executablePath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const currentVersion = options.version ?? VERSION;
	const asset = cliAssetName(platform, arch);
	if (
		!(
			isCompiledCliExecutable(executablePath) &&
			asset &&
			parseVersion(currentVersion)
		)
	) {
		return { status: "not-applicable" };
	}
	const releaseLock = await acquireUpdateLock(`${executablePath}.update.lock`);
	if (!releaseLock) {
		return { status: "unavailable" };
	}
	try {
		return await updateInstalledCli(
			target,
			executablePath,
			platform,
			currentVersion,
			asset,
			options.fetcher ?? fetch
		);
	} finally {
		await releaseLock();
	}
}

async function acquireUpdateLock(
	path: string
): Promise<(() => Promise<void>) | null> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const file = await open(path, "wx", 0o600);
			await file.writeFile(JSON.stringify({ pid: process.pid }));
			await file.close();
			return () => rm(path, { force: true });
		} catch (error) {
			const failure = fileErrorSchema.safeParse(error);
			if (!failure.success || failure.data.code !== "EEXIST") {
				return null;
			}
			try {
				const metadata = updateLockSchema.safeParse(
					JSON.parse(await readFile(path, "utf8"))
				);
				if (!metadata.success) {
					return null;
				}
				try {
					process.kill(metadata.data.pid, 0);
					return null;
				} catch (probeError) {
					const probe = fileErrorSchema.safeParse(probeError);
					if (!probe.success || probe.data.code !== "ESRCH") {
						return null;
					}
				}
				await rm(path, { force: true });
			} catch {
				return null;
			}
		}
	}
	return null;
}

async function updateInstalledCli(
	target: ApiTarget,
	executablePath: string,
	platform: NodeJS.Platform,
	currentVersion: string,
	asset: string,
	fetcher: typeof fetch
): Promise<CliAutoUpdateResult> {
	if (!(await autoUpdatesEnabled(target))) {
		return { status: "disabled" };
	}
	const staged = await applyStagedUpdate(
		executablePath,
		currentVersion,
		asset,
		platform
	);
	if (staged) {
		return staged;
	}
	const channel = releaseChannel(currentVersion);
	const check = await fetchUpdateCheck(target, {
		channel,
		signal: AbortSignal.timeout(API_TIMEOUT_MS),
	});
	if (updateCheckFailed(check) || check.channel !== channel) {
		return { status: "unavailable" };
	}
	if (!isNewerCliVersion(check.latest, currentVersion)) {
		return { status: "current" };
	}
	const tag = check.tag;
	if (
		!(
			tag &&
			validReleaseTag(tag) &&
			releaseTagMatchesVersion(tag, check.latest, channel)
		)
	) {
		return { status: "unavailable" };
	}
	if (
		!(await stageReleaseAsset(
			executablePath,
			asset,
			tag,
			check.latest,
			fetcher
		))
	) {
		return { status: "unavailable" };
	}
	if (!(await autoUpdatesEnabled(target))) {
		return { status: "disabled" };
	}
	return (
		(await applyStagedUpdate(
			executablePath,
			currentVersion,
			asset,
			platform
		)) ?? {
			status: "unavailable",
		}
	);
}

let launchUpdate: Promise<CliAutoUpdateResult> | null = null;

/** One update attempt per terminal process, shared by bootstrap and its notice. */
export function startCliAutoUpdate(
	target: ApiTarget
): Promise<CliAutoUpdateResult> {
	launchUpdate ??= runCliAutoUpdate(target);
	return launchUpdate;
}

/** One-shot commands launch a quiet worker so downloads never delay their output. */
export function startCliAutoUpdateWorker(target: ApiTarget): void {
	if (!isCompiledCliExecutable(process.execPath)) {
		return;
	}
	try {
		const child = spawn(process.execPath, ["--internal-cli-update"], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: {
				...process.env,
				RYU_CORE_URL: target.url,
				RYU_CORE_TOKEN: target.token ?? "",
			},
		});
		child.once("error", () => undefined);
		child.unref();
	} catch {
		// A background update cannot prevent a CLI command from running.
	}
}
