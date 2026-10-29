// Self-bootstrap for the TUI: if the target node is a local loopback address and
// no Core is answering there, resolve (or download) the `ryu-core` binary, spawn it
// bound to that address, and wait for it to come up — the same "just works"
// behaviour the desktop app gives, and a mirror of apps/cli/src/bootstrap.rs.
//
// No-op when Core is already healthy, the target is remote, or RYU_TUI_NO_BOOTSTRAP
// is set. Core self-exits if the bind address is already in use, so a redundant
// spawn is harmless. Bun runtime only (Bun.spawn / Bun.sleep / fetch).

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { binDir, logPath } from "@ryuhq/core-client/data-dir";
import { tf, tr } from "../i18n/translate.ts";
import { cliDataDir } from "./cliStatePath.ts";
import { CORE_IDENTITY_CONFLICT_HINT } from "./coreIdentity.ts";
import { probeCore } from "./nodes.ts";
import { checksumFromText } from "./self-update.ts";

// Public GitHub Releases base — same assets the desktop and one-line installer use.
const RELEASE_BASE = "https://github.com/amajorai/ryu/releases/latest/download";
const HEALTH_POLL_MS = 400;
const HEALTH_TIMEOUT_MS = 30_000;
const CORE_LOG_PATH_ENV = "RYU_CORE_LOG_PATH";
// A release download aborts after this long with no bytes received, so a stalled
// connection cannot hang launch forever. A slow link that keeps making progress
// still completes, under the overall per-request ceiling below.
const DOWNLOAD_STALL_MS = 60_000;
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000;

const isWindows = process.platform === "win32";

// One of the headless binaries the TUI can bootstrap. Core spawns the Gateway itself
// from <data dir>/bin, so both must be present for the governed stack to work.
export type Bin = "core" | "gateway";

function binName(bin: Bin): string {
	return isWindows ? `ryu-${bin}.exe` : `ryu-${bin}`;
}

/** Env var that overrides binary resolution (matches Core's own lookup). */
function binEnvOverride(bin: Bin): string {
	return bin === "core" ? "RYU_CORE_BIN" : "RYU_GATEWAY_BIN";
}

/** `<data dir>/bin`, with the data dir resolved like Core (RYU_DIR > pointer > profile). */
function ryuBinDir(): string {
	return binDir(cliDataDir());
}

/** Release asset name for a platform, or null if unsupported (Intel Mac, ARM Linux). */
function assetName(
	bin: Bin,
	platform: NodeJS.Platform,
	arch: string
): string | null {
	if (platform === "linux" && arch === "x64") {
		return `ryu-${bin}-linux-x86_64`;
	}
	if (platform === "darwin" && arch === "arm64") {
		return `ryu-${bin}-macos-aarch64`;
	}
	if (platform === "win32" && arch === "x64") {
		return `ryu-${bin}-windows-x86_64.exe`;
	}
	return null;
}

/** true for loopback URLs we're allowed to bootstrap. Remote nodes are never spawned. */
export function isLocal(url: string): boolean {
	const host = hostPort(url);
	return (
		host.startsWith("127.0.0.1") ||
		host.startsWith("localhost") ||
		host.startsWith("[::1]") ||
		host.startsWith("0.0.0.0")
	);
}

/** Strip scheme and any path, leaving host:port for --bind=. */
function hostPort(url: string): string {
	const afterScheme = url.includes("://") ? url.split("://")[1] : url;
	return afterScheme.split("/")[0];
}

/** Auto-detect an already-installed binary: $RYU_*_BIN -> <data dir>/bin -> $PATH. */
function resolveBinary(bin: Bin): string | null {
	const override = process.env[binEnvOverride(bin)];
	if (override && existsSync(override)) {
		return override;
	}
	const name = binName(bin);
	const managed = join(ryuBinDir(), name);
	if (existsSync(managed)) {
		return managed;
	}
	for (const entry of (process.env.PATH || "").split(delimiter)) {
		if (!entry) {
			continue;
		}
		const p = join(entry, name);
		if (existsSync(p)) {
			return p;
		}
	}
	return null;
}

/** The installed `ryu-core` binary, or null. Resolution only — never downloads,
 *  so a command that must not side-effect (`ryu acp`) can fail clearly instead. */
export function resolveCoreBinary(): string | null {
	return resolveBinary("core");
}

/** The installed `ryu-gateway` binary, or null. Resolution only, like
 *  {@link resolveCoreBinary}. */
export function resolveGatewayBinary(): string | null {
	return resolveBinary("gateway");
}

export interface DownloadBinaryOptions {
	arch?: string;
	/** Install directory; defaults to <data dir>/bin. */
	binDir?: string;
	fetcher?: typeof fetch;
	platform?: NodeJS.Platform;
	/** Receives the progress line; defaults to stderr (prefixed "ryu: "). */
	report?: Reporter;
	/** Abort a request that receives no bytes for this long. */
	stallTimeoutMs?: number;
	/** Overall ceiling for each request, however much progress it makes. */
	timeoutMs?: number;
}

interface DownloadLimits {
	deadlineMs: number;
	stallMs: number;
}

/**
 * Fetch a release URL into memory, aborting when no bytes arrive for
 * `limits.stallMs` or the request outlives `limits.deadlineMs`. A non-2xx
 * response returns its status with no bytes.
 */
async function fetchReleaseBytes(
	fetcher: typeof fetch,
	url: string,
	limits: DownloadLimits
): Promise<{ bytes: Buffer | null; status: number }> {
	const stall = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const armStall = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			stall.abort(
				new DOMException(
					`download ${url}: no data for ${limits.stallMs}ms`,
					"TimeoutError"
				)
			);
		}, limits.stallMs);
	};
	armStall();
	try {
		const res = await fetcher(url, {
			signal: AbortSignal.any([
				stall.signal,
				AbortSignal.timeout(limits.deadlineMs),
			]),
		});
		if (!res.ok) {
			return { bytes: null, status: res.status };
		}
		const chunks: Uint8Array[] = [];
		const reader = res.body?.getReader();
		if (reader) {
			for (;;) {
				armStall();
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				chunks.push(value);
			}
		}
		return { bytes: Buffer.concat(chunks), status: res.status };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Move a verified download into place. Each launch writes its own temp file, so two
 * first-run launches never share a half-written file. When another launch installed
 * the binary first, its copy is kept rather than replaced while it may be running
 * (Windows also refuses to rename over a running executable).
 */
function installVerifiedBinary(bytes: Buffer, dest: string): string {
	const tmp = `${dest}.${process.pid}-${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, bytes, { mode: 0o755 });
		if (!isWindows) {
			chmodSync(tmp, 0o755);
		}
		if (existsSync(dest)) {
			return dest;
		}
		try {
			renameSync(tmp, dest);
		} catch (err) {
			if (existsSync(dest)) {
				return dest;
			}
			throw err;
		}
		return dest;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Download a release binary into <data dir>/bin. The asset must match its published
 * `.sha256` (fail closed, like install.sh and the CLI self-update), and both
 * requests abort when they stall, so a dead connection cannot hang launch forever.
 */
export async function downloadBinary(
	bin: Bin,
	options: DownloadBinaryOptions = {}
): Promise<string> {
	const {
		arch = process.arch,
		fetcher = fetch,
		platform = process.platform,
		report = stderrReporter,
		stallTimeoutMs = DOWNLOAD_STALL_MS,
		timeoutMs = DOWNLOAD_DEADLINE_MS,
	} = options;
	const limits = { deadlineMs: timeoutMs, stallMs: stallTimeoutMs };
	const asset = assetName(bin, platform, arch);
	if (!asset) {
		throw new Error(
			`no prebuilt ${binName(bin)} for ${platform}-${arch} — build from source or install manually`
		);
	}
	const dir = options.binDir ?? ryuBinDir();
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, binName(bin));
	const url = `${RELEASE_BASE}/${asset}`;

	report(`downloading ${binName(bin)} (${asset})…`);
	// Checksum first: a missing .sha256 refuses the install before the binary is fetched.
	const sum = await fetchReleaseBytes(fetcher, `${url}.sha256`, limits);
	if (!sum.bytes) {
		throw new Error(
			`download ${url}.sha256: HTTP ${sum.status} — refusing to install an unverified binary`
		);
	}
	const expected = checksumFromText(sum.bytes.toString("utf8"), asset);
	if (!expected) {
		throw new Error(`malformed checksum at ${url}.sha256`);
	}
	const { bytes, status } = await fetchReleaseBytes(fetcher, url, limits);
	if (!bytes) {
		throw new Error(`download ${url}: HTTP ${status}`);
	}
	if (bytes.byteLength === 0) {
		throw new Error(`download ${url}: empty body`);
	}
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`checksum mismatch for ${asset} (want ${expected}, got ${actual})`
		);
	}
	return installVerifiedBinary(bytes, dest);
}

/** Auto-detect, then download only if missing. Returns the resolved path. */
async function ensureBinary(bin: Bin, report: Reporter): Promise<string> {
	return resolveBinary(bin) ?? (await downloadBinary(bin, { report }));
}

/** Spawn Core bound to host:port with bounded logging to <data dir>/logs/ryu-core.log. */
function spawnCore(bin: string, bind: string): void {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env[CORE_LOG_PATH_ENV] = logPath(cliDataDir(), "ryu-core.log");
	// unref so the TUI process can exit independently — Core keeps running as the node.
	const proc = Bun.spawn({
		cmd: [bin, `--bind=${bind}`],
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env,
	});
	proc.unref();
}

/** Poll until Core answers and proves itself, something else holds the port,
 *  or the timeout elapses. */
async function waitHealthy(
	target: ApiTarget
): Promise<"ready" | "conflict" | "timeout"> {
	const start = Date.now();
	while (Date.now() - start < HEALTH_TIMEOUT_MS) {
		const probe = await probeCore(target);
		if (probe !== "down") {
			return probe;
		}
		await Bun.sleep(HEALTH_POLL_MS);
	}
	return "timeout";
}

function conflictMessage(url: string): string {
	return tf(
		"the process answering at {url} could not prove it is your Ryu Core; not sending it your node token. {hint}",
		{ hint: tr(CORE_IDENTITY_CONFLICT_HINT), url }
	);
}

/** Progress sink for ensureCoreRunning: one human-readable line per step. */
type Reporter = (message: string) => void;

export interface EnsureCoreOptions {
	/**
	 * Receives each progress/failure line. Defaults to stderr (prefixed "ryu: "),
	 * which is right before the TUI mounts; inside the TUI pass a sink so the
	 * lines land in the UI instead of tearing the rendered frame.
	 */
	onProgress?: Reporter;
}

function stderrReporter(message: string): void {
	process.stderr.write(`ryu: ${message}\n`);
}

/** Whether ensureCoreRunning may act on this URL: local, and not opted out. */
export function canBootstrap(url: string): boolean {
	return isLocal(url) && !process.env.RYU_TUI_NO_BOOTSTRAP;
}

/**
 * Ensure a local Core is running at target.url, starting one if needed. Best-effort:
 * on any failure it reports (stderr by default) and returns, leaving the app to
 * render its usual "core not running" states. No-op when Core is already up, the
 * target is remote, or RYU_TUI_NO_BOOTSTRAP is set.
 */
export async function ensureCoreRunning(
	target: ApiTarget,
	options: EnsureCoreOptions = {}
): Promise<void> {
	if (!canBootstrap(target.url)) {
		return;
	}
	const report = options.onProgress ?? stderrReporter;
	const probe = await probeCore(target);
	if (probe === "ready") {
		return;
	}
	if (probe === "conflict") {
		// An unverified listener owns the port: Core could not bind it anyway,
		// and it must not be treated as Core or handed credentials.
		report(conflictMessage(target.url));
		return;
	}

	let bin: string;
	try {
		bin = await ensureBinary("core", report);
	} catch (err) {
		report(`could not install ryu-core: ${String(err)}`);
		return;
	}

	// Core spawns the Gateway itself from <data dir>/bin, so it must be installed too —
	// otherwise Core boots without the governance layer (routing/firewall/budgets).
	try {
		await ensureBinary("gateway", report);
	} catch (err) {
		report(
			`could not install ryu-gateway (${String(err)}); Core will run without the Gateway`
		);
	}

	const bind = hostPort(target.url);
	report(`starting ryu-core on ${bind}…`);
	try {
		spawnCore(bin, bind);
	} catch (err) {
		report(`could not start ryu-core: ${String(err)}`);
		return;
	}

	const started = await waitHealthy(target);
	if (started === "conflict") {
		report(conflictMessage(target.url));
	} else if (started === "timeout") {
		report(
			`ryu-core did not become healthy within 30s (see ${logPath(cliDataDir(), "ryu-core.log")})`
		);
	}
}
