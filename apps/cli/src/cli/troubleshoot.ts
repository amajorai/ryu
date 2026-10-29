// `ryu troubleshoot [what went wrong…]` — the end-user auto-debugger.
//
// One command walks the whole path a broken install can fail on and ends in
// either a fix or a useful bug report:
//
//   1. Machine     — OS, CPU, memory, disk, runtime, versions (no hostname).
//   2. Local checks — binaries, data dir, disk space, port/profile mix-ups,
//                     recent log errors. These work while Core is DOWN, which
//                     is exactly when people need them.
//   3. Core checks — health, auth, version skew, runtime readiness, Gateway,
//                     missing sidecar binaries, Gateway/plugin doctor counts.
//   4. Updates     — Core's release verdict, or GitHub's latest release when
//                     Core is unreachable.
//   5. --fix       — the few safe repairs: create the data dir, start a local
//                     Core, apply Gateway Doctor's own safe fixes.
//   6. Report      — redacted Markdown saved under `<data dir>/logs/`, similar
//                     issues from the public tracker, and a GitHub new-issue
//                     link with the bug template prefilled. Nothing is posted:
//                     the user reviews and submits in the browser.
//
// Every side effect goes through {@link TroubleshootHost} so tests run without a
// filesystem, sockets, a browser or the network.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, stat, statfs, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import {
	arch,
	cpus,
	freemem,
	homedir,
	release,
	tmpdir,
	totalmem,
} from "node:os";
import { basename, dirname, join } from "node:path";
import { ApiError, type ApiTarget } from "@ryuhq/core-client/client";
import { logPath, ryuProfile } from "@ryuhq/core-client/data-dir";
import {
	buildIssueUrl,
	ISSUE_REPOSITORY,
	problemChecks,
	redactDiagnosticText,
	renderTroubleshootMarkdown,
	type SimilarIssue,
	searchSimilarIssues,
	similarIssueQueries,
	statusMark,
	type TroubleshootCheck,
	type TroubleshootReport,
	troubleshootCounts,
} from "@ryuhq/core-client/troubleshoot";
import { updateCheckResponseSchema } from "@ryuhq/core-client/updates";
import { z } from "zod";
import {
	ensureCoreRunning,
	isLocal,
	resolveCoreBinary,
	resolveGatewayBinary,
} from "../core/bootstrap.ts";
import { cliDataDir } from "../core/cliStatePath.ts";
import { isNewerCliVersion } from "../core/self-update.ts";
import type { CliContext, Command } from "./types.ts";
import { VERSION } from "./version.ts";

const GIB = 1024 ** 3;
const DISK_FAIL_BYTES = 1 * GIB;
const DISK_WARN_BYTES = 5 * GIB;
const LOCAL_MODEL_RAM_BYTES = 8 * GIB;
const CORE_TIMEOUT_MS = 5000;
const GITHUB_TIMEOUT_MS = 8000;
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_LOG_LINES = 20;
const MAX_LOG_LINE_CHARS = 300;
/** Core's release-profile port; profiles add `PROFILE_PORT_OFFSETS`
 *  (crates/core/sidecar-runtime/src/lib.rs). */
const CORE_BASE_PORT = 7980;
const PROFILE_PORT_OFFSETS: ReadonlyArray<readonly [string, number]> = [
	["release", 0],
	["dev", 1000],
	["canary", 2000],
	["nightly", 3000],
	["beta", 4000],
];
const INSTALL_SH =
	"curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh";
const INSTALL_PS1 =
	"irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex";
const USAGE =
	'ryu-cli troubleshoot ["what went wrong"] [--fix] [--dry-run] [--open] [--offline] [--json]';

// ── Host seam ────────────────────────────────────────────────────────────────

export interface DirProbe {
	exists: boolean;
	/** Free bytes on the volume holding the path (or its nearest parent). */
	freeBytes: number | null;
	writable: boolean;
}

/** Every side effect `ryu troubleshoot` performs. Tests pass a fake. */
export interface TroubleshootHost {
	arch: string;
	/** The name the user typed for this CLI (`ryu-cli`, `ryu`), for fix text. */
	commandName: string;
	cpu: { count: number; model: string | null };
	dataDir: string;
	fetch: typeof fetch;
	homeDir: string;
	makeDir: (path: string) => Promise<void>;
	memory: { freeBytes: number; totalBytes: number };
	now: () => Date;
	/** Open a URL in the default browser; false when that is not possible. */
	openUrl: (url: string) => Promise<boolean>;
	osRelease: string;
	platform: NodeJS.Platform;
	probeDir: (path: string) => Promise<DirProbe>;
	/** True when something accepts TCP connections on host:port. */
	probePort: (host: string, port: number) => Promise<boolean>;
	/** The last `maxBytes` of a text file, or null when it cannot be read. */
	readTail: (path: string, maxBytes: number) => Promise<string | null>;
	resolveBinary: (bin: "core" | "gateway") => string | null;
	runtime: string;
	/** Start a local Core (downloading binaries if needed); see bootstrap.ts. */
	startCore: (target: ApiTarget) => Promise<void>;
	tempDir: string;
	writeFile: (path: string, content: string) => Promise<void>;
}

async function nearestExisting(path: string): Promise<string | null> {
	let current = path;
	for (;;) {
		try {
			await stat(current);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	}
}

async function realProbeDir(path: string): Promise<DirProbe> {
	const existing = await nearestExisting(path);
	let freeBytes: number | null = null;
	if (existing) {
		try {
			const fs = await statfs(existing);
			freeBytes = Number(fs.bavail) * Number(fs.bsize);
		} catch {
			freeBytes = null;
		}
	}
	const exists = existing === path;
	let writable = false;
	if (existing) {
		try {
			await access(existing, fsConstants.W_OK);
			writable = true;
		} catch {
			writable = false;
		}
	}
	return { exists, freeBytes, writable };
}

function realProbePort(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(1000, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function realReadTail(
	path: string,
	maxBytes: number
): Promise<string | null> {
	try {
		const handle = await open(path, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, maxBytes);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

function realOpenUrl(url: string): Promise<boolean> {
	// `cmd /c start` splits a URL at `&`; the URL handler takes it verbatim.
	const command =
		process.platform === "win32"
			? ["rundll32", "url.dll,FileProtocolHandler", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	return new Promise((resolve) => {
		try {
			const child = spawn(command[0], command.slice(1), {
				detached: true,
				stdio: "ignore",
			});
			child.once("error", () => resolve(false));
			child.once("spawn", () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

function invokedName(): string {
	const name = basename(process.execPath).replace(/\.exe$/i, "");
	return name.startsWith("ryu") ? name : "ryu";
}

export function realTroubleshootHost(): TroubleshootHost {
	const cpuList = cpus();
	return {
		arch: arch(),
		commandName: invokedName(),
		cpu: { count: cpuList.length, model: cpuList[0]?.model?.trim() || null },
		dataDir: cliDataDir(),
		fetch: globalThis.fetch,
		homeDir: homedir(),
		makeDir: async (path) => {
			await mkdir(path, { recursive: true });
		},
		memory: { freeBytes: freemem(), totalBytes: totalmem() },
		now: () => new Date(),
		openUrl: realOpenUrl,
		osRelease: release(),
		platform: process.platform,
		probeDir: realProbeDir,
		probePort: realProbePort,
		readTail: realReadTail,
		resolveBinary: (bin) =>
			bin === "core" ? resolveCoreBinary() : resolveGatewayBinary(),
		runtime: process.versions.bun
			? `bun ${process.versions.bun}`
			: `node ${process.versions.node}`,
		// Progress (downloads, start-up) goes to stderr, outside `--json` stdout.
		startCore: (target) => ensureCoreRunning(target),
		tempDir: tmpdir(),
		writeFile: async (path, content) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
		},
	};
}

// ── Options ──────────────────────────────────────────────────────────────────

interface TroubleshootOptions {
	description: string;
	dryRun: boolean;
	fix: boolean;
	json: boolean;
	offline: boolean;
	open: boolean;
}

function parseOptions(ctx: CliContext): TroubleshootOptions {
	return {
		description: ctx.args.join(" ").trim(),
		dryRun: ctx.flags.dryRun,
		fix: ctx.flags.fix,
		json: ctx.flags.json,
		offline: ctx.rawArgs.includes("--offline"),
		open: ctx.rawArgs.includes("--open"),
	};
}

// ── Core probes ──────────────────────────────────────────────────────────────

const healthSchema = z.object({
	channel: z.string().optional(),
	gatewayVersion: z.string().nullish(),
	requiredRuntimeReady: z.boolean().optional(),
	status: z.string().optional(),
	version: z.string().optional(),
});
const statusSchema = z.object({
	engine: z
		.object({ active: z.string().nullish(), running: z.boolean().optional() })
		.optional(),
	gateway: z.object({ reachable: z.boolean().optional() }).optional(),
});
const sidecarSchema = z.object({
	missing_binaries: z
		.array(
			z.object({
				expected_asset: z.string().optional(),
				name: z.string(),
			})
		)
		.optional(),
});
const doctorCountsSchema = z.object({
	counts: z.object({
		errors: z.number().catch(0),
		warnings: z.number().catch(0),
	}),
	findings: z
		.array(z.object({ canAutoFix: z.boolean().optional() }))
		.catch(() => []),
});
const doctorResponseSchema = z.object({
	appliedFixes: z.array(z.unknown()).catch(() => []),
	plannedFixes: z.array(z.unknown()).catch(() => []),
	report: doctorCountsSchema.optional(),
});
const systemInfoSchema = z.object({
	gpu_name: z.string().nullish(),
	vram_human: z.string().optional(),
});
const githubReleaseSchema = z.object({
	html_url: z.string().optional(),
	tag_name: z.string(),
});

type CoreFailure = "auth" | "timeout" | "unreachable" | "http";

interface CoreProbe<T> {
	failure: CoreFailure | null;
	message: string;
	value: T | null;
}

function classifyCoreError(error: unknown): {
	failure: CoreFailure;
	message: string;
} {
	if (error instanceof ApiError) {
		return error.status === 401 || error.status === 403
			? { failure: "auth", message: `HTTP ${error.status}` }
			: { failure: "http", message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	const name = error instanceof Error ? error.name : "";
	if (name === "TimeoutError" || name === "AbortError") {
		return { failure: "timeout", message: "timed out" };
	}
	return { failure: "unreachable", message };
}

async function probeCore<T>(
	ctx: CliContext,
	target: ApiTarget,
	path: string,
	schema: z.ZodType<T>
): Promise<CoreProbe<T>> {
	if (!ctx.api.call) {
		return { failure: "unreachable", message: "no Core client", value: null };
	}
	try {
		const raw = await ctx.api.call(target, path, {
			method: "GET",
			signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
		});
		const parsed = schema.safeParse(raw);
		return parsed.success
			? { failure: null, message: "", value: parsed.data }
			: { failure: "http", message: "unexpected response", value: null };
	} catch (error) {
		return { ...classifyCoreError(error), value: null };
	}
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function gib(bytes: number): string {
	return `${(bytes / GIB).toFixed(1)} GB`;
}

function majorMinor(version: string): string {
	return version.replace(/^v/, "").split(".").slice(0, 2).join(".");
}

function portOf(url: string): number | null {
	try {
		const parsed = new URL(url);
		if (parsed.port) {
			return Number(parsed.port);
		}
		return parsed.protocol === "https:" ? 443 : 80;
	} catch {
		return null;
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return "127.0.0.1";
	}
}

function tokenFix(host: TroubleshootHost): string {
	return `Set RYU_CORE_TOKEN to the node's token, or pick a saved node with \`${host.commandName} node use <name>\`.`;
}

function installCommand(host: TroubleshootHost): string {
	return host.platform === "win32" ? INSTALL_PS1 : INSTALL_SH;
}

function portOwnerHint(host: TroubleshootHost, port: number): string {
	return host.platform === "win32"
		? `netstat -ano | findstr :${port}`
		: `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/** Terminal colour codes (`ESC[…m`) that tracing writes into log files. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const ERROR_LINE = /\b(ERROR|FATAL|CRITICAL)\b|panicked at|\bpanic:/;

/** The newest error lines across the given log tails, redacted. */
export function extractLogErrors(
	tails: readonly string[],
	homeDir: string
): string[] {
	const lines: string[] = [];
	for (const tail of tails) {
		for (const raw of tail.split(/\r?\n/)) {
			const line = raw.replace(ANSI, "").trim();
			if (line && ERROR_LINE.test(line)) {
				lines.push(
					redactDiagnosticText(
						line.length > MAX_LOG_LINE_CHARS
							? `${line.slice(0, MAX_LOG_LINE_CHARS)}…`
							: line,
						{ homeDir }
					)
				);
			}
		}
	}
	return lines.slice(-MAX_LOG_LINES);
}

// ── The run ──────────────────────────────────────────────────────────────────

interface RunState {
	checks: TroubleshootCheck[];
	fixes: string[];
	machine: [string, string][];
}

interface CoreSnapshot {
	health: z.infer<typeof healthSchema> | null;
	reachable: boolean;
}

function add(state: RunState, check: TroubleshootCheck): void {
	state.checks.push(check);
}

/** Installed `ryu-core`/`ryu-gateway`, resolved like the bootstrapper does. */
function checkBinaries(
	host: TroubleshootHost,
	local: boolean
): TroubleshootCheck[] {
	if (!local) {
		return [
			{
				id: "install.binaries",
				status: "skip",
				title: "Installed binaries",
				detail: "Core is remote; its binaries live on that machine.",
			},
		];
	}
	const core = host.resolveBinary("core");
	const gateway = host.resolveBinary("gateway");
	return [
		core
			? {
					id: "install.core-binary",
					status: "pass",
					title: "Core binary",
					detail: redactDiagnosticText(core, { homeDir: host.homeDir }),
				}
			: {
					id: "install.core-binary",
					status: "fail",
					title: "Core binary",
					detail:
						"ryu-core was not found in RYU_CORE_BIN, <data dir>/bin, or PATH.",
					fix: `Install it: ${installCommand(host)}  (or run \`${host.commandName} troubleshoot --fix\` to download it)`,
					searchTerms: "ryu-core not found install",
					unit: "apps/cli",
				},
		gateway
			? {
					id: "install.gateway-binary",
					status: "pass",
					title: "Gateway binary",
					detail: redactDiagnosticText(gateway, { homeDir: host.homeDir }),
				}
			: {
					id: "install.gateway-binary",
					status: "warn",
					title: "Gateway binary",
					detail:
						"ryu-gateway was not found; Core runs without routing, firewall, and budgets.",
					fix: `Re-run the installer: ${installCommand(host)}`,
					searchTerms: "ryu-gateway missing",
					unit: "apps/gateway",
				},
	];
}

async function checkDataDir(
	state: RunState,
	host: TroubleshootHost,
	options: TroubleshootOptions
): Promise<void> {
	const shown = redactDiagnosticText(host.dataDir, { homeDir: host.homeDir });
	let probe = await host.probeDir(host.dataDir);
	if (!probe.exists && options.fix) {
		if (options.dryRun) {
			state.fixes.push(`Would create the data directory ${shown}.`);
		} else {
			try {
				await host.makeDir(host.dataDir);
				state.fixes.push(`Created the data directory ${shown}.`);
				probe = await host.probeDir(host.dataDir);
			} catch (error) {
				state.fixes.push(
					`Could not create ${shown}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}
	if (!probe.exists) {
		add(state, {
			id: "data-dir",
			status: probe.writable ? "warn" : "fail",
			title: "Data directory",
			detail: `${shown} does not exist yet${probe.writable ? "; Core creates it on first start." : ", and its parent is not writable."}`,
			fix: probe.writable
				? `Start Core, or run \`${host.commandName} troubleshoot --fix\`.`
				: "Set RYU_DIR to a writable folder, or fix the parent folder's permissions.",
			searchTerms: "data directory permission",
			unit: "apps/core",
		});
	} else if (probe.writable) {
		add(state, {
			id: "data-dir",
			status: "pass",
			title: "Data directory",
			detail: `${shown} is writable.`,
		});
	} else {
		add(state, {
			id: "data-dir",
			status: "fail",
			title: "Data directory",
			detail: `${shown} is not writable by this user.`,
			fix:
				host.platform === "win32"
					? "Give your user Full control of the folder (Properties › Security), or set RYU_DIR to a writable folder."
					: `sudo chown -R "$(whoami)" ${shown}  (it was likely created by a root install), or set RYU_DIR.`,
			searchTerms: "permission denied data directory",
			unit: "apps/core",
		});
	}
	if (probe.freeBytes === null) {
		add(state, {
			id: "disk.free",
			status: "skip",
			title: "Free disk space",
			detail: "Could not read free space for the data directory's volume.",
		});
	} else {
		const free = probe.freeBytes;
		state.machine.push(["Disk free (data volume)", gib(free)]);
		add(state, {
			id: "disk.free",
			status:
				free < DISK_FAIL_BYTES
					? "fail"
					: free < DISK_WARN_BYTES
						? "warn"
						: "pass",
			title: "Free disk space",
			detail: `${gib(free)} free on the data directory's volume.`,
			fix: "Free up space; models and engines need several GB. Move data with RYU_DIR or Settings › Storage.",
			searchTerms: "disk space download failed",
			unit: "apps/core",
		});
	}
}

function checkMemory(state: RunState, host: TroubleshootHost): void {
	const total = host.memory.totalBytes;
	add(state, {
		id: "memory",
		status: "info",
		title: "Memory",
		detail:
			total < LOCAL_MODEL_RAM_BYTES
				? `${gib(total)} total; local models will be slow or fail to load. Prefer a cloud provider.`
				: `${gib(total)} total.`,
	});
}

/** Which other profile's Core answers locally, when the configured one does not. */
async function findOtherProfileCore(
	ctx: CliContext,
	host: TroubleshootHost,
	target: ApiTarget
): Promise<{ port: number; profile: string } | null> {
	const current = portOf(target.url);
	for (const [profile, offset] of PROFILE_PORT_OFFSETS) {
		const port = CORE_BASE_PORT + offset;
		if (port === current || !(await host.probePort("127.0.0.1", port))) {
			continue;
		}
		const probe = await probeCore(
			ctx,
			// Health is public; never hand this node's token to another Core.
			{ url: `http://127.0.0.1:${port}`, token: null },
			"/api/health",
			healthSchema
		);
		if (probe.value) {
			return { port, profile };
		}
	}
	return null;
}

async function checkCore(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	options: TroubleshootOptions
): Promise<CoreSnapshot> {
	const local = isLocal(target.url);
	const shownUrl = redactDiagnosticText(target.url);
	let health = await probeCore(ctx, target, "/api/health", healthSchema);

	if (!health.value && local && options.fix) {
		const port = portOf(target.url);
		const occupied =
			port !== null && (await host.probePort(hostOf(target.url), port));
		if (occupied) {
			state.fixes.push(
				`Did not start Core: something else already listens on port ${port}.`
			);
		} else if (options.dryRun) {
			state.fixes.push(`Would start a local Core at ${shownUrl}.`);
		} else {
			await host.startCore(target);
			health = await probeCore(ctx, target, "/api/health", healthSchema);
			state.fixes.push(
				health.value
					? `Started Core at ${shownUrl}.`
					: `Tried to start Core at ${shownUrl}; it did not become healthy (see the log check below).`
			);
		}
	}

	if (health.value) {
		const version = health.value.version ?? "unknown";
		state.machine.push([
			"Core",
			`${version}${health.value.channel ? ` (${health.value.channel})` : ""}`,
		]);
		if (health.value.gatewayVersion) {
			state.machine.push(["Gateway", health.value.gatewayVersion]);
		}
		add(state, {
			id: "core.reachable",
			status: "pass",
			title: "Core reachable",
			detail: `Core ${version} answers at ${shownUrl}.`,
		});
		return { health: health.value, reachable: true };
	}

	state.machine.push(["Core", "unreachable"]);
	if (health.failure === "auth") {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: `Core at ${shownUrl} refused this CLI (${health.message}).`,
			fix: tokenFix(host),
			searchTerms: "core 401 unauthorized token",
			unit: "apps/cli",
		});
		return { health: null, reachable: false };
	}

	const port = portOf(target.url);
	const occupied =
		local && port !== null && (await host.probePort(hostOf(target.url), port));
	if (occupied) {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: `Something listens on port ${port} but does not answer as Ryu Core (${health.message}).`,
			fix: `Find what owns the port with \`${portOwnerHint(host, port ?? CORE_BASE_PORT)}\`. If it is a stuck ryu-core, stop it and start Core again.`,
			searchTerms: "core port in use",
			unit: "apps/core",
		});
		return { health: null, reachable: false };
	}

	const other = local ? await findOtherProfileCore(ctx, host, target) : null;
	if (other) {
		add(state, {
			id: "core.reachable",
			status: "fail",
			title: "Core reachable",
			detail: `No Core at ${shownUrl}, but a ${other.profile}-profile Core answers on port ${other.port}.`,
			fix: `Point the CLI at it: RYU_PROFILE=${other.profile} (or RYU_CORE_URL=http://127.0.0.1:${other.port}).`,
			searchTerms: "cli cannot connect core profile port",
			unit: "apps/cli",
		});
		return { health: null, reachable: false };
	}

	add(state, {
		id: "core.reachable",
		status: "fail",
		title: "Core reachable",
		detail: local
			? `Nothing is listening at ${shownUrl}; Core is not running.`
			: `Could not reach the remote Core at ${shownUrl} (${health.message}).`,
		fix: local
			? `Start it with \`${host.commandName} troubleshoot --fix\`, by opening \`${host.commandName}\`, or by running \`ryu-core\`.`
			: "Check the node is online and reachable from this machine (VPN, firewall, URL).",
		searchTerms: local ? "core not starting" : "remote node unreachable",
		unit: "apps/core",
	});
	return { health: null, reachable: false };
}

async function checkCoreDetails(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	snapshot: CoreSnapshot,
	options: TroubleshootOptions
): Promise<void> {
	const health = snapshot.health;
	if (!(snapshot.reachable && health)) {
		add(state, {
			id: "core.details",
			status: "skip",
			title: "Core services",
			detail: "Skipped because Core is unreachable.",
		});
		return;
	}

	const coreVersion = health.version ?? "";
	if (coreVersion && majorMinor(coreVersion) !== majorMinor(VERSION)) {
		add(state, {
			id: "core.version-match",
			status: "warn",
			title: "CLI and Core versions",
			detail: `CLI ${VERSION} talks to Core ${coreVersion}; mixed releases can disagree on APIs.`,
			fix: `Update the older one: ${installCommand(host)}`,
			searchTerms: "version mismatch cli core",
			unit: "apps/cli",
		});
	} else {
		add(state, {
			id: "core.version-match",
			status: "pass",
			title: "CLI and Core versions",
			detail: `CLI ${VERSION}, Core ${coreVersion || "unknown"}.`,
		});
	}

	if (health.requiredRuntimeReady === false) {
		add(state, {
			id: "core.runtime-ready",
			status: "warn",
			title: "Core runtime",
			detail: "Core is still installing its required runtime pieces.",
			fix: `Wait a few minutes and re-run; \`${host.commandName} status\` shows progress.`,
			searchTerms: "required runtime not ready",
			unit: "apps/core",
		});
	}

	// `/api/health` is public, so a wrong or missing token first shows up here.
	const status = await probeCore(
		ctx,
		target,
		"/api/system/status",
		statusSchema
	);
	if (status.failure === "auth") {
		add(state, {
			id: "core.auth",
			status: "fail",
			title: "Core access",
			detail: `Core answers but refuses this CLI's requests (${status.message}).`,
			fix: tokenFix(host),
			searchTerms: "core 401 unauthorized token",
			unit: "apps/cli",
		});
		return;
	}
	const [sidecars, info] = await Promise.all([
		probeCore(ctx, target, "/api/sidecar/status", sidecarSchema),
		probeCore(ctx, target, "/api/system/info", systemInfoSchema),
	]);
	if (info.value?.gpu_name) {
		state.machine.push([
			"GPU",
			`${info.value.gpu_name}${info.value.vram_human ? ` (${info.value.vram_human})` : ""}`,
		]);
	}
	if (status.value) {
		const gatewayUp = status.value.gateway?.reachable ?? false;
		add(state, {
			id: "gateway.reachable",
			status: gatewayUp ? "pass" : "fail",
			title: "Gateway",
			detail: gatewayUp
				? "Core reaches its Gateway."
				: "Core cannot reach its Gateway; model routing, firewall, and budgets are down.",
			fix: `Restart Core (it supervises the Gateway). If ryu-gateway is missing, re-run the installer: ${installCommand(host)}`,
			searchTerms: "gateway unreachable",
			unit: "apps/gateway",
		});
		const engine = status.value.engine;
		if (engine?.active && engine.running === false) {
			add(state, {
				id: "engine.running",
				status: "warn",
				title: "Inference engine",
				detail: `The active engine ${engine.active} is not running; local models will not answer.`,
				fix: `Start it with \`${host.commandName} start ${engine.active}\`.`,
				searchTerms: `${engine.active} engine not running`,
				unit: "apps/core",
			});
		}
	} else {
		add(state, {
			id: "gateway.reachable",
			status: "skip",
			title: "Gateway",
			detail: `System status unavailable (${status.message}).`,
		});
	}

	const missing = sidecars.value?.missing_binaries ?? [];
	if (missing.length > 0) {
		add(state, {
			id: "sidecars.binaries",
			status: "fail",
			title: "Sidecar binaries",
			detail: `Missing: ${missing.map((m) => (m.expected_asset ? `${m.name} (${m.expected_asset})` : m.name)).join(", ")}.`,
			fix: `Re-run the installer to restore them: ${installCommand(host)}`,
			searchTerms: `${missing[0]?.name ?? "sidecar"} binary missing`,
			unit: "apps/core",
		});
	} else if (sidecars.value) {
		add(state, {
			id: "sidecars.binaries",
			status: "pass",
			title: "Sidecar binaries",
			detail: "Every enabled sidecar has its binary.",
		});
	}

	await checkGatewayDoctor(ctx, state, host, target, options);

	const plugins = await probeCore(
		ctx,
		target,
		"/api/plugins/doctor",
		z.object({ counts: z.object({ errors: z.number().catch(0) }) })
	);
	if (plugins.value) {
		const errors = plugins.value.counts.errors;
		add(state, {
			id: "plugins.doctor",
			status: errors > 0 ? "warn" : "pass",
			title: "Plugins",
			detail:
				errors > 0
					? `Plugin Doctor found ${errors} error${errors === 1 ? "" : "s"}.`
					: "Plugin Doctor found no errors.",
			fix: `See them with \`${host.commandName} plugin doctor\`.`,
			searchTerms: "plugin doctor error",
			unit: "apps/core",
		});
	}
}

async function checkGatewayDoctor(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	options: TroubleshootOptions
): Promise<void> {
	const doctor = await probeCore(
		ctx,
		target,
		"/api/gateway/doctor",
		doctorCountsSchema
	);
	if (!doctor.value) {
		add(state, {
			id: "gateway.doctor",
			status: "skip",
			title: "Gateway Doctor",
			detail: `Unavailable (${doctor.message}).`,
		});
		return;
	}
	let { errors, warnings } = doctor.value.counts;
	const fixable = doctor.value.findings.filter((f) => f.canAutoFix).length;
	if (options.fix && fixable > 0 && ctx.api.call) {
		try {
			const raw = await ctx.api.call(target, "/api/gateway/doctor/fix", {
				method: "POST",
				body: { dryRun: options.dryRun },
				signal: AbortSignal.timeout(CORE_TIMEOUT_MS * 3),
			});
			const result = doctorResponseSchema.parse(raw);
			const count = options.dryRun
				? result.plannedFixes.length
				: result.appliedFixes.length;
			state.fixes.push(
				options.dryRun
					? `Gateway Doctor would apply ${count} safe fix${count === 1 ? "" : "es"}.`
					: `Gateway Doctor applied ${count} safe fix${count === 1 ? "" : "es"}.`
			);
			if (!options.dryRun && result.report) {
				({ errors, warnings } = result.report.counts);
			}
		} catch (error) {
			state.fixes.push(
				`Gateway Doctor fixes failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	add(state, {
		id: "gateway.doctor",
		status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
		title: "Gateway Doctor",
		detail: `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
		fix:
			fixable > 0 && !options.fix
				? `Preview safe fixes with \`${host.commandName} doctor --dry-run\`, apply with \`${host.commandName} doctor --fix\`.`
				: `Details: \`${host.commandName} doctor\`.`,
		searchTerms: "gateway doctor",
		unit: "apps/gateway",
	});
}

async function checkUpdates(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	snapshot: CoreSnapshot,
	options: TroubleshootOptions
): Promise<void> {
	const fix = `Update: ${installCommand(host)}  (the desktop app updates from Settings › Updates).`;
	if (snapshot.reachable) {
		const verdict = await probeCore(
			ctx,
			target,
			"/api/update/check",
			updateCheckResponseSchema
		);
		const value = verdict.value;
		if (value && !value.error && value.latest) {
			const cliBehind = isNewerCliVersion(value.latest, VERSION);
			const behind = value.update_available || cliBehind;
			add(state, {
				id: "update",
				status: behind ? "warn" : "pass",
				title: "Updates",
				detail: behind
					? `Ryu ${value.latest} is available (Core ${value.current}, CLI ${VERSION}). Your problem may already be fixed.`
					: `Up to date on ${value.channel} (${value.latest}).`,
				fix,
			});
			return;
		}
		if (options.offline) {
			add(state, {
				id: "update",
				status: "skip",
				title: "Updates",
				detail: `Core could not check (${value?.error ?? verdict.message}).`,
			});
			return;
		}
	}
	if (options.offline) {
		add(state, {
			id: "update",
			status: "skip",
			title: "Updates",
			detail: "Skipped (--offline).",
		});
		return;
	}
	try {
		const response = await host.fetch(
			`https://api.github.com/repos/${ISSUE_REPOSITORY}/releases/latest`,
			{
				headers: { Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
			}
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const latest = githubReleaseSchema
			.parse(await response.json())
			.tag_name.replace(/^v/, "");
		const behind = isNewerCliVersion(latest, VERSION);
		add(state, {
			id: "update",
			status: behind ? "warn" : "pass",
			title: "Updates",
			detail: behind
				? `Ryu ${latest} is available (CLI ${VERSION}). Your problem may already be fixed.`
				: `No stable release is newer than CLI ${VERSION} (latest stable: ${latest}).`,
			fix,
		});
	} catch (error) {
		add(state, {
			id: "update",
			status: "warn",
			title: "Updates",
			detail: `Could not reach GitHub to check for updates (${error instanceof Error ? error.message : String(error)}).`,
			// A network problem on this machine, not a Ryu defect: no unit or
			// search terms, so it never decides where the bug report is filed.
			fix: "Check your internet connection or proxy (HTTPS_PROXY); downloads need it too.",
		});
	}
}

function logCandidates(
	host: TroubleshootHost,
	env: CliContext["env"]
): string[] {
	const paths = [
		env.RYU_CORE_LOG_PATH,
		env.RYU_CORE_LOG,
		logPath(host.dataDir, "ryu-core.log"),
		// install.sh's fixed default: `${RYU_CORE_LOG:-$HOME/.ryu/ryu-core.log}`.
		join(host.homeDir, ".ryu", "ryu-core.log"),
	].filter((path): path is string => Boolean(path?.trim()));
	return [...new Set(paths)];
}

async function checkLogs(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost
): Promise<string[]> {
	const tails: string[] = [];
	for (const path of logCandidates(host, ctx.env)) {
		const tail = await host.readTail(path, LOG_TAIL_BYTES);
		if (tail !== null) {
			tails.push(tail);
		}
	}
	if (tails.length === 0) {
		add(state, {
			id: "logs",
			status: "skip",
			title: "Core log",
			detail: "No Core log file found.",
		});
		return [];
	}
	const errors = extractLogErrors(tails, host.homeDir);
	add(state, {
		id: "logs",
		status: errors.length > 0 ? "warn" : "pass",
		title: "Core log",
		detail:
			errors.length > 0
				? `${errors.length} recent error line${errors.length === 1 ? "" : "s"}; latest: ${errors.at(-1)?.slice(0, 160)}`
				: "No recent errors.",
	});
	return errors;
}

function machineInfo(
	host: TroubleshootHost,
	ctx: CliContext
): [string, string][] {
	const env = ctx.env;
	const rows: [string, string][] = [
		["OS", `${host.platform} ${host.osRelease} (${host.arch})`],
		["CPU", `${host.cpu.model ?? "unknown"} × ${host.cpu.count}`],
		[
			"Memory",
			`${gib(host.memory.totalBytes)} total, ${gib(host.memory.freeBytes)} free`,
		],
		["CLI", `ryu-cli ${VERSION} on ${host.runtime}`],
		["Profile", ryuProfile(env)],
		["Core URL", redactDiagnosticText(ctx.target.url)],
		["Data dir", redactDiagnosticText(host.dataDir, { homeDir: host.homeDir })],
	];
	const shell = env.SHELL ?? env.ComSpec;
	if (shell) {
		rows.push(["Shell", basename(shell)]);
	}
	if (env.TERM_PROGRAM) {
		rows.push(["Terminal", env.TERM_PROGRAM]);
	}
	if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY) {
		rows.push(["Proxy", "HTTPS_PROXY/HTTP_PROXY is set"]);
	}
	return rows;
}

async function findSimilarIssues(
	report: TroubleshootReport,
	host: TroubleshootHost,
	options: TroubleshootOptions
): Promise<{ error: string | null; issues: SimilarIssue[] }> {
	if (options.offline) {
		return { error: null, issues: [] };
	}
	const queries = similarIssueQueries(report);
	if (queries.length === 0) {
		return { error: null, issues: [] };
	}
	return await searchSimilarIssues(queries, {
		fetch: host.fetch,
		signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
	});
}

async function saveReport(
	host: TroubleshootHost,
	content: string
): Promise<string | null> {
	const stamp = host.now().toISOString().replace(/[:.]/g, "-");
	const file = `troubleshoot-${stamp}.md`;
	for (const path of [logPath(host.dataDir, file), join(host.tempDir, file)]) {
		try {
			await host.writeFile(path, content);
			return path;
		} catch {
			// Fall through to the temp directory (unwritable or missing data dir).
		}
	}
	return null;
}

// ── Output ───────────────────────────────────────────────────────────────────

interface TroubleshootResult {
	fixes: string[];
	issueUrl: string;
	opened: boolean;
	report: TroubleshootReport;
	reportPath: string | null;
	similarIssuesError: string | null;
}

function renderHuman(
	result: TroubleshootResult,
	host: TroubleshootHost
): string {
	const { report } = result;
	const shownPath = (path: string) =>
		redactDiagnosticText(path, { homeDir: host.homeDir });
	const lines = [
		`Ryu troubleshooter · ryu-cli ${report.version}`,
		"",
		"Machine",
	];
	const labelWidth = Math.max(...report.machine.map(([label]) => label.length));
	for (const [label, value] of report.machine) {
		lines.push(`  ${label.padEnd(labelWidth)}  ${value}`);
	}
	if (result.fixes.length > 0) {
		lines.push("", "Fixes");
		for (const fix of result.fixes) {
			lines.push(`  → ${fix}`);
		}
	}
	lines.push("", "Checks");
	const titleWidth = Math.max(
		...report.checks.map((check) => check.title.length)
	);
	for (const check of report.checks) {
		lines.push(
			`  ${statusMark(check.status)} ${check.title.padEnd(titleWidth)}  ${check.detail}`
		);
		if (check.fix && (check.status === "fail" || check.status === "warn")) {
			lines.push(`    ${" ".repeat(titleWidth)}  Fix: ${check.fix}`);
		}
	}
	const counts = troubleshootCounts(report.checks);
	lines.push(
		"",
		`${counts.pass} passed · ${counts.warn} warnings · ${counts.fail} failed · ${counts.skip} skipped`
	);

	if (report.similarIssues.length > 0) {
		lines.push("", `Similar issues on ${ISSUE_REPOSITORY}`);
		for (const issue of report.similarIssues) {
			lines.push(
				`  #${issue.number} [${issue.state}] ${issue.title}`,
				`    ${issue.url}`
			);
		}
		lines.push(
			"  If one matches, add your report there (a 👍 or a comment) instead of opening a new issue."
		);
	} else if (result.similarIssuesError) {
		lines.push("", `Similar issues: ${result.similarIssuesError}`);
	}

	lines.push("");
	if (result.reportPath) {
		lines.push(
			`Full report saved to ${shownPath(result.reportPath)} (secrets and personal paths removed).`
		);
	}
	const problems = problemChecks(report.checks);
	lines.push(
		problems.length > 0
			? "Still stuck after the fixes above? File a bug report. The form is prefilled; review it before you submit:"
			: "Every check passed. If something is still wrong, describe it and file a bug report:",
		`  ${result.issueUrl}`
	);
	if (result.opened) {
		lines.push("  (Opened in your browser.)");
	} else if (!report.description) {
		lines.push(
			`  Tip: describe the problem to improve the search and the report: ${host.commandName} troubleshoot "what went wrong"`
		);
	}
	return `${lines.join("\n")}\n`;
}

// ── Command ──────────────────────────────────────────────────────────────────

export async function runTroubleshoot(
	ctx: CliContext,
	host: TroubleshootHost
): Promise<number> {
	const options = parseOptions(ctx);
	const target = ctx.target;
	const local = isLocal(target.url);
	const state: RunState = {
		checks: [],
		fixes: [],
		machine: machineInfo(host, ctx),
	};

	add(state, {
		id: "cli.version",
		status: "pass",
		title: "CLI",
		detail: `ryu-cli ${VERSION}.`,
	});
	if (local) {
		await checkDataDir(state, host, options);
	}
	checkMemory(state, host);
	const snapshot = await checkCore(ctx, state, host, target, options);
	// Resolved after `--fix` may have downloaded binaries, shown right after the
	// CLI row so the report reads install → data → Core.
	state.checks.splice(1, 0, ...checkBinaries(host, local));
	await checkCoreDetails(ctx, state, host, target, snapshot, options);
	await checkUpdates(ctx, state, host, target, snapshot, options);
	const logExcerpt = local ? await checkLogs(ctx, state, host) : [];

	const report: TroubleshootReport = {
		checks: state.checks,
		description: redactDiagnosticText(options.description, {
			homeDir: host.homeDir,
		}),
		generatedAt: host.now().toISOString(),
		logExcerpt,
		machine: state.machine,
		similarIssues: [],
		surface: "cli",
		version: VERSION,
	};
	const similar = await findSimilarIssues(report, host, options);
	report.similarIssues = similar.issues;

	const redaction = { homeDir: host.homeDir };
	const issueUrl = buildIssueUrl(report, {
		...redaction,
		fallbackUnit: "apps/cli",
	});
	const reportPath = await saveReport(
		host,
		renderTroubleshootMarkdown(report, { ...redaction, issueUrl })
	);
	const opened = options.open ? await host.openUrl(issueUrl) : false;

	const result: TroubleshootResult = {
		fixes: state.fixes,
		issueUrl,
		opened,
		report,
		reportPath,
		similarIssuesError: similar.error,
	};
	if (options.json) {
		ctx.io.out(
			`${JSON.stringify(
				{
					...result,
					counts: troubleshootCounts(report.checks),
					reportPath: reportPath
						? redactDiagnosticText(reportPath, redaction)
						: null,
				},
				null,
				2
			)}\n`
		);
	} else {
		ctx.io.out(renderHuman(result, host));
	}
	return report.checks.some((check) => check.status === "fail") ? 1 : 0;
}

export const troubleshootCommand: Command = {
	aliases: ["bug-report"],
	name: "troubleshoot",
	summary: "Diagnose this install, apply safe fixes, and prefill a bug report",
	usage: USAGE,
	run: (ctx) =>
		runTroubleshoot(ctx, ctx.troubleshootHost ?? realTroubleshootHost()),
};
