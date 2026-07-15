// Self-bootstrap for the TUI: if the target node is a local loopback address and
// no Core is answering there, resolve (or download) the `ryu-core` binary, spawn it
// bound to that address, and wait for it to come up — the same "just works"
// behaviour the desktop app gives, and a mirror of apps/cli/src/bootstrap.rs.
//
// No-op when Core is already healthy, the target is remote, or RYU_TUI_NO_BOOTSTRAP
// is set. Core self-exits if the bind address is already in use, so a redundant
// spawn is harmless. Bun runtime only (Bun.spawn / Bun.write / fetch).

import {
	chmodSync,
	existsSync,
	mkdirSync,
	openSync,
	renameSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { healthCheck } from "./nodes.ts";

// Public GitHub Releases base — same assets the desktop and one-line installer use.
const RELEASE_BASE = "https://github.com/amajorai/ryu/releases/latest/download";
const HEALTH_POLL_MS = 400;
const HEALTH_TIMEOUT_MS = 30_000;

function homeDir(): string | null {
	return process.env.USERPROFILE || process.env.HOME || null;
}

const isWindows = process.platform === "win32";

// One of the headless binaries the TUI can bootstrap. Core spawns the Gateway itself
// from ~/.ryu/bin, so both must be present for the governed stack to work.
type Bin = "core" | "gateway";

function binName(bin: Bin): string {
	return isWindows ? `ryu-${bin}.exe` : `ryu-${bin}`;
}

/** Env var that overrides binary resolution (matches Core's own lookup). */
function binEnvOverride(bin: Bin): string {
	return bin === "core" ? "RYU_CORE_BIN" : "RYU_GATEWAY_BIN";
}

function ryuBinDir(): string | null {
	const home = homeDir();
	return home ? join(home, ".ryu", "bin") : null;
}

/** Release asset name for this platform, or null if unsupported (Intel Mac, ARM Linux). */
function assetName(bin: Bin): string | null {
	const { platform, arch } = process;
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

/** Auto-detect an already-installed binary: $RYU_*_BIN -> ~/.ryu/bin -> $PATH. */
function resolveBinary(bin: Bin): string | null {
	const override = process.env[binEnvOverride(bin)];
	if (override && existsSync(override)) {
		return override;
	}
	const name = binName(bin);
	const dir = ryuBinDir();
	if (dir) {
		const p = join(dir, name);
		if (existsSync(p)) {
			return p;
		}
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

/** Download a binary into ~/.ryu/bin (temp file + atomic rename, chmod 0o755 on unix). */
async function downloadBinary(bin: Bin): Promise<string> {
	const asset = assetName(bin);
	if (!asset) {
		throw new Error(
			`no prebuilt ${binName(bin)} for ${process.platform}-${process.arch} — build from source or install manually`
		);
	}
	const dir = ryuBinDir();
	if (!dir) {
		throw new Error("could not resolve home directory");
	}
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, binName(bin));
	const url = `${RELEASE_BASE}/${asset}`;

	process.stderr.write(`ryu: downloading ${binName(bin)} (${asset})…\n`);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`download ${url}: HTTP ${res.status}`);
	}
	// Temp path then rename, so an interrupted download never leaves a truncated
	// binary that looks installed.
	const tmp = `${dest}.download`;
	await Bun.write(tmp, res);
	if (!isWindows) {
		chmodSync(tmp, 0o755);
	}
	renameSync(tmp, dest);
	return dest;
}

/** Auto-detect, then download only if missing. Returns the resolved path. */
async function ensureBinary(bin: Bin): Promise<string> {
	return resolveBinary(bin) ?? (await downloadBinary(bin));
}

/** Spawn Core bound to host:port, detached, logging to ~/.ryu/ryu-core.log. */
function spawnCore(bin: string, bind: string): void {
	const home = homeDir();
	let out: number | "ignore" = "ignore";
	if (home) {
		try {
			out = openSync(join(home, ".ryu", "ryu-core.log"), "a");
		} catch {
			out = "ignore";
		}
	}
	// unref so the TUI process can exit independently — Core keeps running as the node.
	const proc = Bun.spawn({
		cmd: [bin, `--bind=${bind}`],
		stdin: "ignore",
		stdout: out,
		stderr: out,
	});
	proc.unref();
}

/** Poll health until Core answers or the timeout elapses. */
async function waitHealthy(target: ApiTarget): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < HEALTH_TIMEOUT_MS) {
		if (await healthCheck(target)) {
			return true;
		}
		await Bun.sleep(HEALTH_POLL_MS);
	}
	return false;
}

/**
 * Ensure a local Core is running at target.url, starting one if needed. Best-effort:
 * on any failure it logs to stderr and returns, leaving the app to render its usual
 * "core not running" states. No-op when Core is already up, the target is remote, or
 * RYU_TUI_NO_BOOTSTRAP is set.
 */
export async function ensureCoreRunning(target: ApiTarget): Promise<void> {
	if (!isLocal(target.url)) {
		return;
	}
	if (process.env.RYU_TUI_NO_BOOTSTRAP) {
		return;
	}
	if (await healthCheck(target)) {
		return;
	}

	let bin: string;
	try {
		bin = await ensureBinary("core");
	} catch (err) {
		process.stderr.write(`ryu: could not install ryu-core: ${String(err)}\n`);
		return;
	}

	// Core spawns the Gateway itself from ~/.ryu/bin, so it must be installed too —
	// otherwise Core boots without the governance layer (routing/firewall/budgets).
	try {
		await ensureBinary("gateway");
	} catch (err) {
		process.stderr.write(
			`ryu: could not install ryu-gateway (${String(err)}); Core will run without the Gateway\n`
		);
	}

	const bind = hostPort(target.url);
	process.stderr.write(`ryu: starting ryu-core on ${bind}…\n`);
	try {
		spawnCore(bin, bind);
	} catch (err) {
		process.stderr.write(`ryu: could not start ryu-core: ${String(err)}\n`);
		return;
	}

	if (!(await waitHealthy(target))) {
		process.stderr.write(
			"ryu: ryu-core did not become healthy within 30s (see ~/.ryu/ryu-core.log)\n"
		);
	}
}
