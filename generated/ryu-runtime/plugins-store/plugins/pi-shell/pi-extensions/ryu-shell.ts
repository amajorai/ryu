/**
 * Ryu background shells — a Pi extension that gives the flagship, managed "ryu"
 * (Pi) agent long-running background commands.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi says so itself (`pi/docs/usage.md:309`): it "intentionally does not include
 * built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background
 * bash". Every other ACP agent Ryu speaks to (Claude Code, Codex) can start a dev
 * server, a watcher or a long build and keep working while it runs; the flagship
 * agent could not. Pi's built-in `bash` tool is synchronous — it holds the turn
 * open for the whole command — so "start the dev server, then edit a file" either
 * blocks until a timeout or is impossible. This extension adds the missing half:
 * three tools that spawn, poll and stop detachable work WITHOUT holding the turn.
 *
 * DESIGN: PULL OUTPUT, PUSH LIFECYCLE
 * -----------------------------------
 * `bash_background` returns the instant the child is spawned, handing back a
 * shell id. Output is PULLED afterwards with `bash_output`, which drains a capped
 * ring buffer and reports the exit code once the process has ended. `onUpdate`
 * cannot carry a later completion because it is scoped to the live
 * `execute()` invocation (`pi-agent-core/dist/types.d.ts` — "Calls made after the
 * tool promise settles are ignored"). Pi's extension-level `sendMessage` IS the
 * later lifecycle channel: a natural exit/failure/TTL stop injects a displayed
 * custom message and triggers (or queues behind) a parent turn. That turn is
 * told to collect `bash_output`, so the final bytes and exit state travel through
 * the same visible tool transaction as an explicit poll. Manual `bash_kill` and
 * `bash_output(kill=true)` already return that state synchronously and therefore
 * suppress the duplicate wake-up.
 *
 * Shells deliberately SURVIVE ACROSS TURNS inside one conversation. Core's ACP
 * pool keys on the conversation id and builds one pi-acp instance per pooled
 * entry, so this module's state outlives an individual turn — that is exactly
 * what makes "start it, keep working, check on it" possible, and the tool
 * descriptions say so to the model.
 *
 * WHY NOTHING HERE IS NAMED `bash`
 * --------------------------------
 * pi-acp special-cases the tool name, verbatim (`dist/index.js`, from
 * `src/acp/translate/bash.ts`):
 *
 *     function isBashTool(toolName) { return toolName.toLowerCase() === "bash"; }
 *
 * A match hijacks the call into Zed's terminal-rendering path
 * (`emitBashToolCall` + `bashTerminalOutputMeta`) and drops `rawOutput`
 * ENTIRELY — the tool result travels as terminal `_meta` instead. Ryu's desktop
 * reads neither, so a background shell named `bash`, `Bash` or `BASH` would
 * render as an empty terminal card with no output at all. The comparison is
 * exact equality, not a prefix or substring test, so `bash_background` /
 * `bash_output` / `bash_kill` are safe: they take the generic branch, keep their
 * `rawInput`/`rawOutput`, and arrive with `kind: "other"` (`toToolKind`'s
 * default). They are also deliberately NOT in Core's `KNOWN_TOOLS`
 * (`sidecar/adapters/mod.rs::acp_tool_ui_name`), so they render as ordinary
 * dynamic tool rows — which is correct, because the desktop has no
 * background-shell card for them to land on.
 *
 * WE DO NOT OVERRIDE PI'S BUILT-IN `bash`
 * ---------------------------------------
 * Pi exposes a `createBashTool({ spawnHook })` seam (see
 * `examples/extensions/bash-spawn-hook.ts`) and it is genuinely the right place
 * to inject sandbox/exec policy later. Replacing the primary bash tool is also
 * the single highest-blast-radius change available in this file — every command
 * the agent runs would flow through code shipped here. Out of scope; this
 * extension only ADDS tools. Note the consequence honestly: Pi's built-in bash
 * remains outside Core's exec-scan (Core only scans inside the ACP
 * `request_permission` handler, which Pi never triggers).
 *
 * ORPHAN PREVENTION — THE LARGEST RISK IN THIS FILE
 * -------------------------------------------------
 * A background shell that outlives its Pi process is a leak that MULTIPLIES per
 * chat: Core's ACP pool SIGTERMs an instance on idle-TTL, and pi-acp's
 * `closeAllExcept` kills the previous conversation's Pi on every `session/new`.
 * Three defences, and the FIRST one is the one that actually does the work:
 *   1. `stopAllShells()` from Pi's `session_shutdown`, AND defensively at the top
 *      of the factory (jiti can hand back a cached module whose module-level
 *      `Map` survived a reload, leaving children nothing else would ever kill —
 *      `ryu-lsp.ts` defends the same way for the same reason). This IS the
 *      guarantee, and it reaches further than it looks: Pi's rpc mode runs
 *      `shutdown()` from stdin `end` as well as from SIGTERM, and `shutdown()`
 *      AWAITS `runtimeHost.dispose()`, which awaits every `session_shutdown`
 *      handler before `process.exit`. So Core SIGKILLing pi-acp still closes
 *      Pi's stdin, and pi-acp's own `closeAllExcept` SIGTERM lands on the same
 *      path. A subagent child reaches it through print mode's
 *      `finally { await disposeRuntime() }`.
 *   2. `MAX_SHELLS`, claimed at spawn against the LIVE count, atomically (see
 *      `reserveShell` — Pi runs a message's tool calls concurrently, so the
 *      check and the registration must not be separated by an `await`).
 *   3. A per-shell TTL timer: SIGTERM at `SHELL_TTL_MS`, SIGKILL `TERM_GRACE_MS`
 *      later. Every timer is `unref`'d — a live timer keeps Node's event loop
 *      open and would stop Pi exiting cleanly, which is the orphan-adjacent
 *      failure this is here to prevent.
 *
 * `detached: false` is NOT a fourth defence, and must not be described as one.
 * It keeps the child in Pi's process group, but nothing in Ryu ever signals a
 * process group: pi-acp's `dispose()` is `child.kill(signal)` on one pid, Core's
 * ACP child is SIGKILLed by one pid through `ChildGuard::drop`, and no
 * `process_group`/`setsid` appears anywhere in `apps/core` or `crates/` outside
 * the integration-test harness. On POSIX a child does not die because its parent
 * did. Setting `detached: true` would still be strictly WORSE (its own group
 * exists precisely so the child survives), so keep the explicit `false` — just
 * do not count it as a guarantee.
 *
 * RESIDUAL WINDOW, stated so nobody re-derives it as a surprise: if Pi is
 * SIGKILLed or crashes, none of the three defences runs — the TTL timer and the
 * `MAX_SHELLS` count both died inside Pi — and the shells are orphaned with no
 * lifetime bound at all. A real bound for that case has to live INSIDE the
 * spawned command (a ppid watchdog prefix), not in Pi. Not done here.
 *
 * RESTART NOTIFICATION (the durable-ledger section below) does not close that
 * window — nothing Pi-side can — but it stops the orphan from being SILENT.
 * Every spawn, finish and release is written to a per-project ledger file that
 * survives the process, and the next Pi for the project tells its agent about
 * shells a previous process left running with no completion record, marking
 * them stopped so the agent re-verifies (is the port still bound?) instead of
 * assuming its server is up. This is a straight copy of Claude Code's "N
 * background task(s) from the previous session have no completion record".
 * The notice is injected once per process, before the first turn's LLM call,
 * via the `context` event; a stale `shell_id` passed to `bash_output`/`bash_kill`
 * after a restart also consults the ledger so the model reads the shell's story
 * rather than a bare "unknown id". The ledger deliberately never carries output
 * (it died with the process) and orphans are marked stopped, not signalled
 * (the pid may belong to a different process by now).
 *
 * What is deliberately NOT done: `process.on("exit" | "SIGTERM")` handlers.
 * Registering a SIGTERM listener in Node SUPPRESSES the default terminate
 * behaviour, so it would make the Pi process HARDER to kill — it makes this risk
 * worse, not better, and an `exit` handler cannot await a kill anyway.
 *
 * KNOWN BOUND: GRANDCHILDREN OF A COMPOUND COMMAND
 * ------------------------------------------------
 * The command runs through a shell (`shell: true`), which execs simple commands
 * but stays resident for compound ones (`a && b`, pipelines, `&`). Killing the
 * shell then leaves its own children behind. The usual fix — spawn into a fresh
 * process group and signal `-pid` — requires `detached: true`, which costs
 * defence (1) above, the more important guarantee. So this is accepted and
 * documented rather than engineered around: prefer one command per background
 * shell, and treat `bash_kill` on a compound command as best-effort.
 *
 * NO SLASH COMMANDS, EVER
 * -----------------------
 * `pi.registerCommand` must not be used in any Ryu Pi extension reached over ACP.
 * Pi's `AgentSession.prompt` short-circuits a registered extension command BEFORE
 * `_runAgentPrompt`, so no `agent_start`/`agent_end` is ever emitted; pi-acp's
 * `startTurn` settles `pendingTurn` only from `agent_end`, so the ACP
 * `session/prompt` request never returns and the chat spins until Core's turn
 * timeout. Registering a command here would DEADLOCK the turn that invoked it.
 *
 * THE REASON CHANNEL IS STDERR — AND UNDER ACP NOBODY READS IT
 * ------------------------------------------------------------
 * Over ACP the managed Pi runs headless as far as anyone watching is concerned,
 * so `ctx.ui.*` is not a reporting channel either, and stderr is what is left.
 * Be honest about where it goes: pi-acp spawns Pi with `stdio: "pipe"` and its
 * ONLY handler for that stream is `child.stderr.on("data", () => {})` — a no-op
 * sink. It is never forwarded to pi-acp's own stderr and never put on the ACP
 * wire, so Core's `acp_subprocess` WARN log carries PI-ACP's stderr, not Pi's.
 * A `[ryu-shell]` line is therefore visible when Pi is run standalone (a TUI, a
 * direct `pi --mode rpc`) and discarded under Ryu. These lines are a debugging
 * aid, not a record; nothing here relies on one being read.
 */

import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-shell]";

/**
 * Hard cap on shells running AT ONCE. Counted over live shells only (see
 * `liveShells`), so an exited-but-undrained shell never consumes a slot the user
 * cannot get back. Four is enough for the real workloads (a dev server, a
 * watcher, a build, one spare) and low enough that a model in a retry loop
 * cannot quietly turn one chat into a fork bomb.
 */
const MAX_SHELLS = 4;

/**
 * Hard lifetime cap. A background shell is for work the user is waiting on
 * DURING a conversation; anything still alive after half an hour is far more
 * likely to be forgotten than wanted, and Pi may by then have been replaced by
 * the pool without ever delivering `session_shutdown`. On expiry the shell is
 * terminated with a reason the next `bash_output` reports, so the model is told
 * rather than left believing its server is still up.
 */
const SHELL_TTL_MS = 30 * 60 * 1000;

/**
 * Grace between SIGTERM and SIGKILL. Long enough for a dev server to run its own
 * shutdown handlers and release its port, short enough that a wedged child is
 * reaped well inside a turn.
 */
const TERM_GRACE_MS = 5000;

/**
 * Ring-buffer ceiling per shell, oldest chunks dropped first. A watcher left
 * running for twenty minutes can emit megabytes; without a cap the buffer grows
 * until Pi dies of memory exhaustion, and with an uncapped DRAIN a single
 * `bash_output` would blow the model's whole context window on build noise.
 * Dropped bytes are counted and reported (see `drainShell`) — silently handing
 * the model a truncated log it believes is complete is the failure mode this
 * whole accounting exists to prevent.
 */
const BUFFER_CAP_BYTES = 256 * 1024;

/**
 * How many EXITED shells are retained for their output to be collected. An
 * exited shell survives so `bash_output` can still report its exit code and
 * final bytes, but a `Map` that only ever grows would pin
 * `BUFFER_CAP_BYTES` × N for the rest of the conversation. Oldest finished
 * entries beyond this are evicted at the next spawn.
 */
const MAX_FINISHED_RETAINED = MAX_SHELLS;

/**
 * The ledger file name, written inside the session directory (per project). The
 * session dir is stable across Pi processes for a project, which is what makes
 * orphan detection possible at all: a record written here by a dead process is
 * read by the next one.
 */
const LEDGER_FILE = "ryu-background-shells.json";

/**
 * How long finished/stopped records are retained before pruning. Long enough
 * that a record's story survives a restart well past the point anyone cares,
 * short enough that the file cannot grow without bound across many sessions.
 */
const LEDGER_PRUNE_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on non-running ledger records. Running records are already bounded by
 * `MAX_SHELLS`; this caps the finished/stopped tail so an abandoned project's
 * ledger never becomes a pile of corpses.
 */
const LEDGER_MAX_ENTRIES = MAX_SHELLS * 4;

/** Shell id prefix. Short, greppable, and obviously not a pid. */
const SHELL_ID_PREFIX = "bg_";

/**
 * Recursion/scoping marker set by `ryu-subagent.ts` on every child it spawns.
 * This name is a CROSS-FILE CONTRACT shared with `ryu-subagent.ts` (which sets
 * it) and `ryu-plan.ts` (which reads it to no-op its interactive confirm in a
 * child). Nothing pins the three spellings together — rename in all three or in
 * none.
 */
const SUBAGENT_MARKER = "RYU_PI_SUBAGENT";

// ── Runtime state ───────────────────────────────────────────────────────────

/** How a child ended. `undefined` on the shell means it is still running. */
interface ShellExit {
	code: number | null;
	/** Set when the extension itself stopped it (TTL, explicit kill, teardown). */
	reason?: string;
	signal: NodeJS.Signals | null;
}

interface BackgroundShell {
	/** Byte size of the retained chunks, kept incrementally so drains are O(1). */
	bytes: number;
	child: ChildProcess | undefined;
	command: string;
	cwd: string;
	description?: string;
	/** Bytes discarded by the ring buffer since the last drain. */
	dropped: number;
	/** Set exactly once, when the child exits or fails to spawn. */
	exit?: ShellExit;
	id: string;
	/** Interleaved stdout+stderr chunks awaiting collection. */
	out: string[];
	/**
	 * Why this extension is stopping the shell, recorded BEFORE the signal is
	 * sent. `spawnShell` installs the persistent `exit` listener first, so it wins
	 * the race against the one `terminate` adds and would otherwise record a bare
	 * "killed by SIGTERM" — losing the only explanation the model would ever get
	 * for a shell that hit its lifetime cap.
	 */
	pendingReason?: string;
	pid?: number;
	startedAt: number;
	/** Manual/session teardown already reports elsewhere; avoid a duplicate turn. */
	suppressCompletionNotification?: boolean;
	/** The lifetime cap. Always `unref`'d; cleared the moment the child exits. */
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * The durable half of a background shell, as written to the ledger. The ledger
 * is the only thing that survives a Pi process dying, so it carries everything
 * a later process needs to tell the agent what happened.
 */
interface ShellRecord {
	code?: number | null;
	command: string;
	cwd: string;
	description?: string;
	finished_at?: number;
	pid?: number;
	/**
	 * The pid of the Pi process that spawned this shell. The orphan
	 * discriminator: on scan, only records written by a DIFFERENT pid are
	 * orphans — a same-pid record belongs to a live process that can still
	 * finish it (a reload's teardown does exactly that).
	 */
	process_pid: number;
	reason?: string;
	signal?: string | null;
	started_at: number;
	/** `running` | `finished` (ended inside a live process) | `stopped` (orphan, marked at scan). */
	status: "running" | "finished" | "stopped";
}

/** The ledger file's shape. Versioned so a future layout change can migrate. */
interface ShellLedger {
	shells: Record<string, ShellRecord>;
	version: 1;
}

/**
 * The shell registry. Module-level ON PURPOSE — it is what lets a shell outlive
 * the turn that started it (see the preamble). It is also why the factory tears
 * down before rebinding: jiti may return this same module, and this same Map,
 * across a reload.
 */
let shells = new Map<string, BackgroundShell>();

/** Monotonic id source. Never reset, so an id is never reused within a process. */
let nextShellId = 1;

/**
 * The session directory the ledger lives in, cached on first sight. Ledger
 * writes are no-ops until this is set — there is nothing durable to do without
 * a place to put it, and every write is guarded anyway.
 */
let ledgerDir: string | undefined;

/**
 * True once this process has scanned the ledger for orphans. The `context`
 * event fires before EVERY LLM call, so this flag is what makes the restart
 * notice appear exactly once per process.
 */
let orphanScanDone = false;

/** Bound by the extension factory; undefined while the session is tearing down. */
let reportCompletion: ((shell: BackgroundShell) => void) | undefined;

/** The process owner advertised to Core's generic background-process bridge. */
const BACKGROUND_PRODUCER = "@ryu/pi-shell";

/** One poller services every live shell in this Pi process. */
let controlPollTimer: ReturnType<typeof setInterval> | undefined;
let controlPollInFlight = false;

// ── Small helpers ───────────────────────────────────────────────────────────

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The reason channel. Visible when Pi is run standalone; DISCARDED under Ryu,
 * because pi-acp sinks its child's stderr into a no-op handler (see the
 * preamble). A debugging aid, never a record — nothing here may depend on one of
 * these lines being read.
 */
function log(message: string): void {
	try {
		process.stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		// A closed stderr must never break a turn.
	}
}

function backgroundProcessId(shellOrId: BackgroundShell | string): string {
	const shellId = typeof shellOrId === "string" ? shellOrId : shellOrId.id;
	return `${process.pid}:${shellId}`;
}

function coreUrl(): string | undefined {
	const raw = process.env.RYU_MCP_CORE_URL?.trim();
	return raw ? raw.replace(/\/+$/, "") : undefined;
}

async function coreBackgroundRequest<T>(
	requestPath: string,
	init: RequestInit,
	quiet = false
): Promise<T | undefined> {
	const base = coreUrl();
	if (!base) {
		return undefined;
	}
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	const token = process.env.RYU_MCP_CORE_TOKEN?.trim();
	if (token) {
		headers.set("authorization", `Bearer ${token}`);
	}
	const userJwt = process.env.RYU_MCP_USER_JWT?.trim();
	if (userJwt) {
		headers.set("x-ryu-user-jwt", userJwt);
	}
	try {
		const response = await fetch(`${base}${requestPath}`, {
			...init,
			headers,
		});
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		return (await response.json()) as T;
	} catch (error) {
		if (!quiet) {
			log(
				`Core background bridge ${requestPath} failed (${errorText(error)}).`
			);
		}
		return undefined;
	}
}

function backgroundProcessSnapshot(shell: BackgroundShell) {
	const exit = shell.exit;
	return {
		process_id: backgroundProcessId(shell),
		shell_id: shell.id,
		producer: BACKGROUND_PRODUCER,
		kind: "shell",
		label: shell.description ?? shell.command,
		description: shell.description,
		command: shell.command,
		cwd: shell.cwd,
		pid: shell.pid,
		started_at: shell.startedAt,
		elapsed_ms: Date.now() - shell.startedAt,
		running: isLive(shell),
		exit_code: exit?.code ?? null,
		exit_signal: exit?.signal ?? null,
	};
}

async function publishBackgroundProcess(shell: BackgroundShell): Promise<void> {
	await coreBackgroundRequest(
		"/api/background/processes/sync",
		{
			body: JSON.stringify({ process: backgroundProcessSnapshot(shell) }),
			method: "POST",
		},
		true
	);
}

async function releaseBackgroundProcess(processId: string): Promise<void> {
	await coreBackgroundRequest(
		"/api/background/processes/release",
		{ body: JSON.stringify({ process_id: processId }), method: "POST" },
		true
	);
}

function stopControlPoller(): void {
	if (controlPollTimer) {
		clearInterval(controlPollTimer);
		controlPollTimer = undefined;
	}
}

async function pollStopRequests(): Promise<void> {
	if (controlPollInFlight || !coreUrl()) {
		return;
	}
	const live = liveShells();
	if (live.length === 0) {
		stopControlPoller();
		return;
	}
	controlPollInFlight = true;
	await Promise.all(live.map((shell) => publishBackgroundProcess(shell)));
	const response = await coreBackgroundRequest<{
		stops?: Array<{ process_id?: string; reason?: string }>;
	}>(
		"/api/background/processes/control",
		{
			body: JSON.stringify({
				process_ids: live.map((shell) => backgroundProcessId(shell)),
			}),
			method: "POST",
		},
		true
	);
	controlPollInFlight = false;
	for (const stop of response?.stops ?? []) {
		if (typeof stop.process_id !== "string") {
			continue;
		}
		const shell = live.find(
			(candidate) => backgroundProcessId(candidate) === stop.process_id
		);
		if (shell && isLive(shell)) {
			await terminate(shell, stop.reason?.trim() || "stopped from Ryu");
		}
	}
	if (liveShells().length === 0) {
		stopControlPoller();
	}
}

function ensureControlPoller(): void {
	if (!coreUrl() || controlPollTimer) {
		return;
	}
	controlPollTimer = setInterval(() => {
		void pollStopRequests();
	}, 500);
	controlPollTimer.unref?.();
	void pollStopRequests();
}

/**
 * True while the child is still running (or is still trying to start).
 *
 * INVARIANT, and the reason this reads `exit` rather than `child`: `exit` is set
 * and `child` is cleared together, in `finish`, and nowhere else. A shell that
 * stayed live with no child would permanently consume a `MAX_SHELLS` slot with
 * nothing left to kill — `terminate` early-returns on a missing child — so any
 * future edit that clears `child` outside `finish` must be treated as a bug.
 *
 * There is exactly ONE deliberate window where a live shell has no child: a
 * RESERVATION (`reserveShell`), which holds its slot across the `await` that
 * resolves the cwd. `startShell` fills the child in and `releaseReservation`
 * gives the slot back if the spawn never happens, so the window is bounded by
 * one `stat()` and cannot leak — but the window has to exist, because the cap
 * check and the registration must be in the same synchronous run (see
 * `reserveShell`).
 */
function isLive(shell: BackgroundShell): boolean {
	return shell.exit === undefined;
}

/** The shells currently occupying a `MAX_SHELLS` slot. */
function liveShells(): BackgroundShell[] {
	return [...shells.values()].filter(isLive);
}

/** Compact elapsed time, so the model can judge whether to keep waiting. */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
	}
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** One line per shell — what the caller needs to pick the right `shell_id`. */
function formatShellList(): string {
	const entries = [...shells.values()];
	if (entries.length === 0) {
		return "No background shells exist.";
	}
	return entries
		.map((shell) => {
			const state = isLive(shell)
				? `running for ${formatDuration(Date.now() - shell.startedAt)}`
				: describeExit(shell);
			return `- ${shell.id}: ${state} — ${shell.command}`;
		})
		.join("\n");
}

/** How a finished shell ended, in one phrase the model can act on. */
function describeExit(shell: BackgroundShell): string {
	const exit = shell.exit;
	if (!exit) {
		return "running";
	}
	if (exit.reason) {
		return `stopped — ${exit.reason}`;
	}
	if (exit.signal) {
		return `killed by ${exit.signal}`;
	}
	return `exited with code ${exit.code ?? 0}`;
}

// ── Output buffering ────────────────────────────────────────────────────────

/**
 * Append a chunk, evicting the oldest chunks until the retained size is back
 * under the cap. Eviction is counted, never silent: `drainShell` prefixes the
 * drained text with the loss so the model cannot mistake a truncated tail for a
 * complete log.
 */
function appendChunk(shell: BackgroundShell, chunk: string): void {
	shell.out.push(chunk);
	shell.bytes += Buffer.byteLength(chunk);
	while (shell.bytes > BUFFER_CAP_BYTES && shell.out.length > 1) {
		const evicted = shell.out.shift() ?? "";
		const size = Buffer.byteLength(evicted);
		shell.bytes -= size;
		shell.dropped += size;
	}
}

/**
 * Take everything buffered and reset the buffer, so consecutive `bash_output`
 * calls return only what is NEW. This is the whole polling contract: a drain is
 * destructive, and the model is told as much in the tool description.
 */
function drainShell(shell: BackgroundShell): string {
	const text = shell.out.join("");
	const dropped = shell.dropped;
	shell.out = [];
	shell.bytes = 0;
	shell.dropped = 0;
	if (dropped > 0) {
		return `${LOG_PREFIX} dropped ${dropped} earlier bytes (buffer cap ${BUFFER_CAP_BYTES} bytes)\n${text}`;
	}
	return text;
}

// ── Durable ledger & restart notification ────────────────────────────────────
//
// Everything above is in-memory and dies with the Pi process. That is fine for
// the running conversation, but it is exactly the hole this section exists to
// paper over: if Pi is SIGKILLed or crashes, the TTL timer and the `MAX_SHELLS`
// count die inside it and the shells are orphaned with no record anywhere.
// Claude Code's bash tool has the same hole and handles it by telling the NEXT
// session about it — "N background shell command task(s) from the previous
// session have no completion record … they have been marked stopped" — so the
// agent re-verifies instead of assuming its server is still up.
//
// We copy that. Every shell is written to a durable ledger the moment it
// spawns, marked finished the moment it ends, and deleted once its final output
// has been collected. The ledger lives in the session directory
// (`~/.ryu/pi-agent/sessions/<encoded-cwd>/ryu-background-shells.json`), which
// is per-project and survives the process, so the next Pi for this project can
// tell which shells were still running when the previous one died. On the first
// LLM call of a new process we scan it: any shell recorded as running by a
// DIFFERENT pid is an orphan — it may have been stopped when the session died
// or may still be running — so we mark it stopped and inject a notice into the
// model's context. One notice per process, injected before the first turn's LLM
// call, so the agent re-verifies before continuing.
//
// Two deliberate bounds on the ledger's honesty:
//   - It records spawns, finishes and releases, never output. A restarted agent
//     is told that bg_1 ended and why, not what it printed — the ring buffer
//     died with the process.
//   - Orphans are marked stopped but NOT signalled. The child's pid may belong
//     to a different process by now, so killing by pid would be worse than
//     leaving it. The agent is told to verify (is the port still bound?) rather
//     than asked to trust that "stopped" killed anything.
//
// One scoping consequence, stated so nobody re-derives it as a surprise: the
// ledger is keyed by the session DIRECTORY, i.e. per project, not per
// conversation. Two conversations in one project share it, so a fresh chat can
// be told about a shell an older chat started. That is the price of surviving a
// hard kill (the conversation id exists only inside the dead process), and it
// is the safe direction to err: an agent told "a previous session's shell may
// still be running <command>" verifies before starting a conflicting dev server.

// ── Ledger I/O ──────────────────────────────────────────────────────────────

function ledgerPath(): string | undefined {
	return ledgerDir ? path.join(ledgerDir, LEDGER_FILE) : undefined;
}

/** Read the ledger. Any failure yields an empty ledger — the file is advisory. */
function loadLedger(): ShellLedger {
	const file = ledgerPath();
	if (!file) {
		return { version: 1, shells: {} };
	}
	try {
		if (!existsSync(file)) {
			return { version: 1, shells: {} };
		}
		const parsed = JSON.parse(
			readFileSync(file, "utf8")
		) as Partial<ShellLedger>;
		return { version: 1, shells: parsed.shells ?? {} };
	} catch (err) {
		log(`ledger read failed (${errorText(err)}); treating as empty.`);
		return { version: 1, shells: {} };
	}
}

/** Write the ledger. A failure is logged, never thrown — the ledger must not break a turn. */
function saveLedger(ledger: ShellLedger): void {
	const file = ledgerPath();
	if (!file) {
		return;
	}
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(ledger, null, "\t"));
	} catch (err) {
		log(
			`ledger write failed (${errorText(err)}); shell state will not survive a restart.`
		);
	}
}

/**
 * Read-modify-write the ledger in ONE synchronous run. Every writer goes through
 * this: Pi executes a message's tool calls concurrently, and the synchronous fs
 * calls serialize on the event loop, so a read and a write from two parallel
 * spawns cannot interleave. `mutate` runs inside the try — a bad record must
 * never be saved back.
 */
function updateLedger(mutate: (ledger: ShellLedger) => void): void {
	const ledger = loadLedger();
	try {
		mutate(ledger);
	} catch (err) {
		log(`ledger update failed (${errorText(err)}).`);
		return;
	}
	saveLedger(ledger);
}

/** Drop records that are no longer worth keeping: old finished ones, and a hard cap on the rest. */
function pruneLedger(ledger: ShellLedger): void {
	const now = Date.now();
	for (const [id, rec] of Object.entries(ledger.shells)) {
		if (rec.status === "running") {
			continue;
		}
		const doneAt = rec.finished_at ?? rec.started_at;
		if (now - doneAt > LEDGER_PRUNE_MS) {
			delete ledger.shells[id];
		}
	}
	const nonRunning = Object.entries(ledger.shells)
		.filter(([, rec]) => rec.status !== "running")
		.sort((a, b) => a[1].started_at - b[1].started_at);
	for (const [id] of nonRunning.slice(
		0,
		Math.max(0, nonRunning.length - LEDGER_MAX_ENTRIES)
	)) {
		delete ledger.shells[id];
	}
}

/** Remember where the ledger lives, once, from the first context in sight. */
function rememberSessionDir(ctx: ExtensionContext): void {
	if (ledgerDir) {
		return;
	}
	try {
		ledgerDir = ctx.sessionManager.getSessionDir() || undefined;
	} catch {
		ledgerDir = undefined;
	}
}

/** Persist a freshly spawned shell so a later process can see it never finished. */
function recordStarted(shell: BackgroundShell): void {
	if (ledgerPath()) {
		updateLedger((ledger) => {
			pruneLedger(ledger);
			ledger.shells[shell.id] = {
				command: shell.command,
				cwd: shell.cwd,
				description: shell.description,
				pid: shell.pid,
				process_pid: process.pid,
				started_at: shell.startedAt,
				status: "running",
			};
		});
	}
	void publishBackgroundProcess(shell);
	ensureControlPoller();
}

/**
 * Mark a shell finished in the ledger. Called from `finish`, the single choke
 * point every terminal transition (natural exit, kill, TTL, teardown) passes
 * through, so a finished record always carries the same story the model would
 * have been told.
 */
function recordFinished(shell: BackgroundShell): void {
	if (!ledgerPath()) {
		return;
	}
	updateLedger((ledger) => {
		const rec = ledger.shells[shell.id];
		if (!rec) {
			return;
		}
		rec.status = "finished";
		rec.code = shell.exit?.code ?? null;
		rec.signal = shell.exit?.signal ?? null;
		rec.reason = shell.exit?.reason;
		rec.finished_at = Date.now();
	});
}

/** Forget a shell whose final output has been collected. Mirrors the in-memory release. */
function recordReleased(id: string): void {
	void releaseBackgroundProcess(backgroundProcessId(id));
	if (ledgerPath()) {
		updateLedger((ledger) => {
			delete ledger.shells[id];
		});
	}
}

/** The ledger record for an id, or undefined. Used to explain a stale id to the model. */
function ledgerRecord(id: string): ShellRecord | undefined {
	return loadLedger().shells[id];
}

/** One-line state description of a ledger record, for the model. */
function describeLedgerRecord(rec: ShellRecord): string {
	const when = formatDuration(Date.now() - rec.started_at);
	const head = `${rec.command} (started ${when} ago, cwd: ${rec.cwd})`;
	if (rec.status === "stopped") {
		return `${head} — stopped (${rec.reason ?? "no reason recorded"})`;
	}
	if (rec.status === "finished") {
		const why =
			rec.reason ??
			(rec.signal
				? `killed by ${rec.signal}`
				: `exited with code ${rec.code ?? 0}`);
		return `${head} — finished (${why})`;
	}
	return `${head} — recorded as running`;
}

// ── Orphan scan & notification ───────────────────────────────────────────────

/**
 * Collect shells the previous Pi process left running — records written by a
 * DIFFERENT pid with no completion. Marks them `stopped` so a later process
 * does not re-notify, and returns them for the notice. A record written by THIS
 * pid is skipped: it belongs to a live process that can still finish it.
 */
function claimOrphans(): Array<{ id: string; rec: ShellRecord }> {
	const ledger = loadLedger();
	const orphans = Object.entries(ledger.shells)
		.filter(
			([, rec]) => rec.status === "running" && rec.process_pid !== process.pid
		)
		.map(([id, rec]) => ({ id, rec }));
	if (orphans.length === 0) {
		return [];
	}
	const now = Date.now();
	for (const { rec } of orphans) {
		rec.status = "stopped";
		rec.reason = "the previous session ended";
		rec.finished_at = now;
	}
	saveLedger(ledger);
	return orphans;
}

/** The restart notice, mirroring Claude Code's background-task warning. */
function buildOrphanNotice(
	orphans: Array<{ id: string; rec: ShellRecord }>
): string {
	const plural =
		orphans.length === 1 ? "background shell has" : "background shells have";
	const lines = orphans
		.map(
			({ id, rec }) =>
				`- ${id}: ${rec.command} (cwd: ${rec.cwd}, started ${formatDuration(Date.now() - rec.started_at)} ago)`
		)
		.join("\n");
	return [
		"Session restarted — re-verifying state before continuing.",
		"",
		`⏺ ${orphans.length} ${plural} no completion record from the previous session. They may have been stopped when that session ended, or they may have been running when the previous process exited. They have been marked stopped.`,
		"",
		lines,
		"",
		"Verify their actual state before assuming anything they were doing is still live — e.g. check whether a dev server is still bound to its port, and restart anything the current task depends on.",
	].join("\n");
}

/**
 * The `context` event fires before every LLM call. On the first one of this
 * process we scan the ledger for shells a previous process left running, mark
 * them stopped, and inject the notice into the messages the model is about to
 * see — the one time, per process, the agent is told its background shells may
 * not have survived the restart.
 */
function notifyOrphans(
	ctx: ExtensionContext,
	messages: ContextEvent["messages"]
): void {
	if (orphanScanDone) {
		return;
	}
	orphanScanDone = true;
	rememberSessionDir(ctx);
	const orphans = claimOrphans();
	if (orphans.length === 0) {
		return;
	}
	log(
		`marked ${orphans.length} orphaned shell(s) as stopped; notifying the agent.`
	);
	try {
		messages.push({
			role: "user",
			content: [{ type: "text" as const, text: buildOrphanNotice(orphans) }],
			timestamp: Date.now(),
		});
	} catch (err) {
		log(`could not inject the restart notice (${errorText(err)}).`);
	}
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Clear the lifetime timer. Idempotent; safe on an already-finished shell. */
function clearTtl(shell: BackgroundShell): void {
	if (shell.timer) {
		clearTimeout(shell.timer);
		shell.timer = undefined;
	}
}

/**
 * Record the end of a shell exactly once. Called from both `exit` and `error`,
 * either of which may arrive first, so the first writer wins and the second is a
 * no-op — otherwise a spawn failure followed by an exit would overwrite the
 * useful reason with a bare code.
 */
function finish(shell: BackgroundShell, exit: ShellExit): void {
	clearTtl(shell);
	if (shell.exit) {
		return;
	}
	// `pendingReason` is the fallback, not the override: an explicit reason passed
	// here is always more specific than the one recorded before the signal.
	shell.exit = { ...exit, reason: exit.reason ?? shell.pendingReason };
	shell.child = undefined;
	// Consumed, so a reused entry can never inherit an unrelated explanation.
	shell.pendingReason = undefined;
	// Persist the completion so a later process does not mistake this shell for
	// an orphan (see the durable-ledger section). No-op when no ledger exists.
	recordFinished(shell);
	void publishBackgroundProcess(shell);
	if (!shell.suppressCompletionNotification) {
		reportCompletion?.(shell);
	}
}

/**
 * SIGTERM, then SIGKILL at the grace deadline. Resolves when the child is gone
 * or the deadline has passed — never rejects, because every caller is on a path
 * (teardown, TTL expiry, an explicit kill) where a failure to stop cleanly must
 * not become a failed turn.
 *
 * The grace timer is `unref`'d: a pending kill must never be the reason Node
 * keeps the Pi process alive.
 */
function terminate(
	shell: BackgroundShell,
	reason: string,
	wakeAgentOnFinish = false
): Promise<void> {
	clearTtl(shell);
	shell.suppressCompletionNotification = !wakeAgentOnFinish;
	const child = shell.child;
	if (!(child && isLive(shell))) {
		return Promise.resolve();
	}
	// Recorded BEFORE the signal, because `spawnShell`'s persistent `exit`
	// listener fires ahead of the one installed below and would otherwise finish
	// the shell with no explanation at all.
	shell.pendingReason = reason;
	if (child.exitCode !== null || child.signalCode !== null) {
		finish(shell, { code: child.exitCode, signal: child.signalCode, reason });
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		const grace = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already reaped between the deadline firing and this call.
			}
			finish(shell, { code: null, signal: "SIGKILL", reason });
			resolve();
		}, TERM_GRACE_MS);
		grace.unref?.();
		child.once("exit", (code, signal) => {
			clearTimeout(grace);
			finish(shell, { code, signal, reason });
			resolve();
		});
		try {
			child.kill("SIGTERM");
		} catch (err) {
			clearTimeout(grace);
			finish(shell, { code: null, signal: null, reason: errorText(err) });
			resolve();
		}
	});
}

/**
 * Stop every shell and empty the registry. Idempotent by construction, which
 * matters twice over: `session_shutdown` may be delivered more than once, and
 * the factory calls this defensively against a jiti-cached module whose Map
 * survived a reload.
 */
async function stopAllShells(reason: string): Promise<void> {
	stopControlPoller();
	const entries = [...shells.values()];
	shells = new Map();
	await Promise.all(
		entries.map((shell) =>
			terminate(shell, reason).catch((err: unknown) => {
				log(`${shell.id}: teardown failed (${errorText(err)}).`);
			})
		)
	);
}

/**
 * Evict the oldest FINISHED shells once more than `MAX_FINISHED_RETAINED` are
 * held. Running shells are never evicted — they are bounded by `MAX_SHELLS`
 * instead — so this only reclaims buffers the model never came back for.
 */
function pruneFinished(): void {
	const finished = [...shells.values()]
		.filter((shell) => !isLive(shell))
		.sort((a, b) => a.startedAt - b.startedAt);
	for (const shell of finished.slice(
		0,
		Math.max(0, finished.length - MAX_FINISHED_RETAINED)
	)) {
		shells.delete(shell.id);
	}
}

/**
 * Claim a `MAX_SHELLS` slot and register the shell, all in ONE synchronous run.
 *
 * The check and the registration cannot be separated by an `await`. Pi executes
 * a message's tool calls CONCURRENTLY (`pi-agent-core`'s `executeToolCallsParallel`
 * runs every prepared call through one `Promise.all`, and nothing here declares
 * `executionMode: "sequential"`), so a model that emits eight `bash_background`
 * calls in one message enters `execute` eight times before any of them yields.
 * If the cap were checked, then the cwd awaited, then the entry registered, all
 * eight would read a live count of zero and all eight would spawn — with the
 * cap being the only in-process bound on concurrent shells, that is the whole
 * defence gone. Reserving here closes it: the count and the insert happen
 * without an interleaving point between them.
 *
 * The reservation is a LIVE shell with no child yet (see `isLive`).
 * `startShell` completes it and `releaseReservation` rolls it back.
 */
function reserveShell(
	command: string,
	description: string | undefined
): BackgroundShell {
	const live = liveShells();
	if (live.length >= MAX_SHELLS) {
		throw new Error(
			`bash_background: ${MAX_SHELLS} background shells are already running. Stop one with bash_kill first.\n${formatShellList()}`
		);
	}
	const id = `${SHELL_ID_PREFIX}${nextShellId}`;
	nextShellId += 1;
	const shell: BackgroundShell = {
		bytes: 0,
		child: undefined,
		command,
		// Replaced by `startShell` once the real one has been resolved; a
		// reservation is never spawned into, so this placeholder never runs.
		cwd: "",
		description,
		dropped: 0,
		id,
		out: [],
		startedAt: Date.now(),
	};
	shells.set(id, shell);
	return shell;
}

/**
 * Hand a reserved slot back when the spawn never happened. Deliberately narrow:
 * it deletes the entry only while it is still the reservation this call made and
 * still childless, so it can never remove a running shell that reused the id
 * (ids are monotonic, so it cannot — the guard is there to keep that true under
 * a future edit).
 */
function releaseReservation(shell: BackgroundShell): void {
	if (shells.get(shell.id) === shell && shell.child === undefined) {
		shells.delete(shell.id);
	}
}

/**
 * Spawn the child for an already-reserved shell.
 *
 * `detached: false` is stated explicitly even though it is Node's default: an
 * explicit `false` is what makes a future "let's detach it" edit obviously
 * wrong, and detaching would put the child in its own process group precisely so
 * it SURVIVES Pi (see the preamble's orphan section). The environment is
 * inherited verbatim and deliberately — Core injects the gateway routing
 * variables into the Pi spawn, and a child that does not inherit them would
 * escape that governance.
 *
 * Throws without spawning if the reservation is gone: `stopAllShells` swaps the
 * registry for a fresh Map, so a shell reserved before a teardown would
 * otherwise be spawned into a registry nothing will ever tear down again.
 */
function startShell(shell: BackgroundShell, cwd: string): BackgroundShell {
	if (shells.get(shell.id) !== shell) {
		throw new Error(
			"bash_background: the session was torn down while this shell was starting."
		);
	}
	shell.cwd = cwd;
	const id = shell.id;
	const command = shell.command;

	const child = spawn(command, {
		cwd,
		detached: false,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	shell.child = child;
	shell.pid = child.pid;

	// stdout and stderr share one buffer on purpose: interleaved is how the user
	// would see it in a terminal, and tagging each chunk would corrupt the line
	// structure of build output the model has to read.
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => appendChunk(shell, chunk));
	child.stderr?.on("data", (chunk: string) => appendChunk(shell, chunk));

	// A spawn failure (bad cwd, no shell) surfaces asynchronously and would
	// otherwise be an unhandled 'error' event, which is fatal to the Pi process.
	child.on("error", (err) => {
		appendChunk(shell, `${LOG_PREFIX} spawn failed: ${errorText(err)}\n`);
		finish(shell, { code: null, signal: null, reason: errorText(err) });
	});
	child.on("exit", (code, signal) => {
		finish(shell, { code, signal });
	});

	shell.timer = setTimeout(() => {
		log(`${id}: lifetime cap reached, terminating — ${command}`);
		terminate(
			shell,
			`exceeded the ${formatDuration(SHELL_TTL_MS)} lifetime cap`,
			true
		).catch(() => {
			// `terminate` never rejects; this is belt-and-braces so a detached
			// timer can never become an unhandled rejection in Pi's process.
		});
	}, SHELL_TTL_MS);
	shell.timer.unref?.();

	// No `shells.set` here: `reserveShell` already registered this entry, which
	// is the point — the slot was taken before the cwd was awaited.
	log(`${id}: started (pid ${child.pid ?? "?"}) in ${cwd} — ${command}`);
	return shell;
}

/**
 * Resolve a caller-supplied cwd against the session's cwd and confirm it is a
 * directory BEFORE spawning. Without the check the failure arrives later as an
 * async 'error' event, so `bash_background` would report success for a shell
 * that never ran and the model would poll a corpse.
 */
async function resolveCwd(raw: unknown, sessionCwd: string): Promise<string> {
	const requested = typeof raw === "string" ? raw.trim() : "";
	if (!requested) {
		return sessionCwd;
	}
	const resolved = path.resolve(sessionCwd, requested);
	const info = await stat(resolved).catch(() => undefined);
	if (!info?.isDirectory()) {
		throw new Error(`cwd is not a directory: ${resolved}`);
	}
	return resolved;
}

/** The structured half of a tool result, identical across all three tools. */
function shellDetails(shell: BackgroundShell, drainedChars: number) {
	const background = backgroundProcessSnapshot(shell);
	return {
		command: shell.command,
		cwd: shell.cwd,
		description: shell.description,
		drained_chars: drainedChars,
		elapsed_ms: Date.now() - shell.startedAt,
		exit_code: shell.exit?.code ?? undefined,
		exit_signal: shell.exit?.signal ?? undefined,
		pid: shell.pid,
		running: isLive(shell),
		shell_id: shell.id,
		process_id: background.process_id,
		producer: background.producer,
		kind: background.kind,
		started_at: background.started_at,
		background_process: background,
	};
}

/**
 * Look a shell up, or throw the id list. Throwing marks the tool result
 * `isError` and shows the model the reason, which is exactly what it needs to
 * recover from a stale or invented id.
 */
function requireShell(raw: unknown): BackgroundShell {
	const id = typeof raw === "string" ? raw.trim() : "";
	const shell = id ? shells.get(id) : undefined;
	if (!shell) {
		// Not in this process's registry. Before declaring it unknown, consult the
		// durable ledger: a shell the PREVIOUS process left running (an orphan,
		// marked stopped at the restart scan) still has a record there, and the
		// model deserves its story rather than a bare "unknown id".
		const rec = ledgerRecord(id);
		if (rec && rec.status !== "running") {
			throw new Error(
				`shell_id ${JSON.stringify(id)} is no longer managed: ${describeLedgerRecord(rec)}.\n${formatShellList()}`
			);
		}
		throw new Error(
			`unknown shell_id ${JSON.stringify(id)}. Shells are released once their final output has been collected.\n${formatShellList()}`
		);
	}
	return shell;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Tear down anything a previous bind left behind. Pi emits `session_shutdown`
	// before rebinding, so this is normally a no-op; it exists because jiti may
	// hand back a cached module whose `shells` Map survived, and those children
	// would then be unkillable by anything in this process.
	if (shells.size > 0) {
		stopAllShells("the extension was reloaded").catch(() => {
			// Best effort; the empty registry installed above is what matters.
		});
	}

	// A subagent child (`ryu-subagent.ts` spawns `pi --mode json -p` with this
	// marker set) registers NO background shells, for two independent reasons.
	// Budget: `MAX_SHELLS` is per process, so an unscoped child would get four
	// slots of its own that the parent can neither see, list nor kill — and one
	// parent turn can start several children. Usefulness: a child's whole life is
	// one non-interactive turn, and its shells are torn down with it, so nothing
	// it backgrounds can outlive the call that would read the output. The `Task`
	// tool is registered under the same marker check for the same reason.
	if (process.env[SUBAGENT_MARKER] === "1") {
		log("running as a subagent child; background shells are not registered");
		return;
	}

	// A background completion happens after `bash_background.execute` has
	// returned, so only the extension-level session channel can both preserve it
	// for the model and wake the parent. `deliverAs: followUp` queues safely when
	// the shell exits during an active turn; `triggerTurn` handles an idle parent.
	reportCompletion = (shell) => {
		const state = describeExit(shell);
		pi.sendMessage(
			{
				customType: "ryu-background-shell-lifecycle",
				content: [
					`Background shell ${shell.id} ${state}.`,
					`command: ${shell.command}`,
					`cwd: ${shell.cwd}`,
					`Call bash_output with shell_id "${shell.id}" now to collect its final output and surface the completed lifecycle transaction to the user.`,
				].join("\n"),
				details: shellDetails(shell, 0),
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true }
		);
	};

	pi.registerTool({
		name: "bash_background",
		label: "Background Shell",
		description:
			"Start a shell command in the background and return immediately with a " +
			"shell id. The command keeps running across later turns in this " +
			"conversation until it finishes, you stop it with bash_kill, or it hits " +
			`its ${formatDuration(SHELL_TTL_MS)} lifetime cap. Read its output with ` +
			"bash_output. Use this only for work that does not finish quickly — dev " +
			"servers, file watchers, long builds and test suites; use the built-in " +
			"bash tool for anything that returns in seconds. " +
			`At most ${MAX_SHELLS} background shells may run at once. ` +
			"If the session is restarted while one is running you will be told it " +
			"has been marked stopped — re-verify its actual state then.",
		promptSnippet: "Run a long-lived command in the background",
		promptGuidelines: [
			"Use the built-in bash tool for any command that finishes in seconds; bash_background is only for commands that keep running (dev servers, watchers, long builds and test suites).",
			"bash_background returns a shell_id immediately and does NOT wait for output; poll it with bash_output and stop it with bash_kill when you are done.",
			"Background shells stay alive across turns in this conversation, so check for one you already started before starting another.",
			"When told that background shells from a previous session were marked stopped, re-verify their actual state before assuming a command is still running (e.g. is the dev server still bound to its port?).",
			"Start one command per background shell; a compound command's grandchildren may survive bash_kill.",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"The shell command to run in the background, e.g. `npm run dev`.",
			}),
			cwd: Type.Optional(
				Type.String({
					description:
						"Directory to run in. Relative paths resolve against the session's working directory. Defaults to it.",
				})
			),
			description: Type.Optional(
				Type.String({
					description:
						"Short human-readable label for this shell, e.g. `dev server`.",
				})
			),
		}),
		// `async` on purpose even though the body reads synchronously up to the
		// cwd check: it turns every validation throw below into a rejection, which
		// is the shape Pi turns into an `isError` tool result the model can read.
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = String(params?.command ?? "").trim();
			if (!command) {
				throw new Error("bash_background: `command` is required.");
			}
			const description =
				typeof params?.description === "string"
					? params.description.trim() || undefined
					: undefined;
			// The cap check and the registration happen together, with NO `await`
			// between them — Pi runs a message's tool calls concurrently, so a
			// check-then-await-then-register would let a whole batch past a cap none
			// of them had claimed yet. See `reserveShell`. The cap counts LIVE shells
			// only, so a finished-but-undrained shell never holds a slot the caller
			// has no way to release.
			const reserved = reserveShell(command, description);
			let shell: BackgroundShell;
			try {
				const resolved = await resolveCwd(params?.cwd, ctx.cwd);
				pruneFinished();
				shell = startShell(reserved, resolved);
			} catch (err) {
				// A rejected cwd (or a session torn down mid-start) must not leave the
				// slot claimed; the error is re-thrown so the model still reads the
				// reason as an `isError` result.
				releaseReservation(reserved);
				throw err;
			}
			// Persist the spawn so a later process can tell this shell never
			// finished (the restart-notification ledger).
			rememberSessionDir(ctx);
			recordStarted(shell);
			const cwd = shell.cwd;
			const text = [
				`Started background shell ${shell.id} (pid ${shell.pid ?? "unknown"}).`,
				`command: ${command}`,
				`cwd: ${cwd}`,
				`Call bash_output with shell_id "${shell.id}" to collect new output, and bash_kill to stop it. It keeps running across turns until then.`,
			].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: shellDetails(shell, 0),
			};
		},
	});

	pi.registerTool({
		name: "bash_output",
		label: "Background Shell Output",
		description:
			"Collect output a background shell has produced since the last check, " +
			"and report whether it is still running or how it exited. The read is " +
			"destructive: each call returns only what is NEW, so poll rather than " +
			"re-reading. Once a finished shell's final output has been collected its " +
			"id is released. Pass kill=true to stop the shell after collecting. " +
			"After a session restart a shell id that was never released reports its " +
			"recorded end state instead of failing as unknown.",
		promptSnippet: "Read new output from a background shell",
		promptGuidelines: [
			"Poll bash_output to follow a background shell; each call returns only output produced since the previous call.",
			"A background shell is still running until bash_output reports an exit code — do not assume a server is up just because bash_background returned.",
		],
		parameters: Type.Object({
			shell_id: Type.String({
				description: "The id returned by bash_background, e.g. `bg_1`.",
			}),
			kill: Type.Optional(
				Type.Boolean({
					description:
						"Stop the shell after collecting its output. Defaults to false.",
				})
			),
		}),
		async execute(_toolCallId, params) {
			const shell = requireShell(params?.shell_id);
			if (params?.kill === true) {
				await terminate(shell, "bash_output(kill=true)");
			}
			const output = drainShell(shell);
			const finished = !isLive(shell);
			const elapsed = formatDuration(Date.now() - shell.startedAt);
			const state = finished
				? `${describeExit(shell)} after ${elapsed}`
				: `running for ${elapsed}`;
			const header = `${shell.id} — ${state}\ncommand: ${shell.command}`;
			const body = output
				? `--- new output ---\n${output}`
				: "(no new output since the last check)";
			// Release the id only once the caller has seen the FINAL output. Holding
			// finished shells until then is what makes "the process ended and here is
			// why" reportable at all; releasing after is what keeps the registry from
			// growing for the rest of the conversation.
			if (finished) {
				shells.delete(shell.id);
				recordReleased(shell.id);
			}
			const tail = finished
				? `\nShell ${shell.id} has ended and its id is now released.`
				: "";
			return {
				content: [{ type: "text" as const, text: `${header}\n${body}${tail}` }],
				details: shellDetails(shell, output.length),
			};
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "Stop Background Shell",
		description:
			"Stop a background shell (SIGTERM, then SIGKILL after a short grace) and " +
			"return whatever output it had not yet handed over. The shell id is " +
			"released. Stop shells you started as soon as you no longer need them.",
		promptSnippet: "Stop a background shell",
		promptGuidelines: [
			"Stop every background shell you started with bash_kill once it is no longer needed; they otherwise keep running for the rest of the conversation.",
		],
		parameters: Type.Object({
			shell_id: Type.String({
				description: "The id returned by bash_background, e.g. `bg_1`.",
			}),
		}),
		async execute(_toolCallId, params) {
			const shell = requireShell(params?.shell_id);
			await terminate(shell, "bash_kill");
			const output = drainShell(shell);
			shells.delete(shell.id);
			recordReleased(shell.id);
			const text = [
				`Stopped ${shell.id} after ${formatDuration(Date.now() - shell.startedAt)}.`,
				`command: ${shell.command}`,
				output ? `--- final output ---\n${output}` : "(no remaining output)",
			].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: shellDetails(shell, output.length),
			};
		},
	});

	// Fires for `quit` AND for session replacement (`new` / `resume` / `fork`).
	// It is NOT guaranteed to arrive at all — Core's pool and pi-acp's
	// `closeAllExcept` both kill Pi outright — which is precisely why it is the
	// last of four defences rather than the only one.
	pi.on("session_shutdown", async () => {
		await stopAllShells("the session ended");
		reportCompletion = undefined;
	});

	// The restart-notification seam (Claude Code's "background task(s) from the
	// previous session have no completion record" notice). Fires before every
	// LLM call; the guard inside makes the orphan notice appear exactly once per
	// process, on the first call — i.e. just before the agent's first turn after
	// a restart decides what to do.
	pi.on("context", (event, ctx) => {
		notifyOrphans(ctx, event.messages);
	});
}
