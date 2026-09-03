/**
 * Ryu monitor — the `monitor` tool for the flagship, managed "ryu" (Pi) agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi's own `docs/usage.md:309` lists what it deliberately does not ship:
 * "built-in MCP, sub-agents, permission popups, plan mode, to-dos, or
 * background bash". A monitor is not on that list, but Pi has none — and a
 * monitoring capability is the one thing Claude Code's `Monitor` tool gives
 * the other ACP agents Ryu speaks to that the flagship could not do. This
 * extension closes that gap the way Pi intends: as an extension, shipped from
 * Core next to `ryu-shell.ts` and `ryu-subagent.ts`.
 *
 * It is a FROM-SCRATCH implementation of the same idea as Claude Code's
 * `Monitor` (see https://code.claude.com/docs/en/tools-reference#monitor-tool):
 * let the agent watch something in the background and react when it changes.
 * No Claude code is copied; the design is re-derived against Pi's actual
 * extension API and against the one hard constraint that API imposes.
 *
 * THE HARD CONSTRAINT: PUSH ONLY EXISTS INSIDE A LIVE `execute()`
 * ----------------------------------------------------------------
 * `onUpdate` is scoped to the live `execute()` invocation
 * (`pi-agent-core/dist/types.d.ts` — "Calls made after the tool promise
 * settles are ignored"), so a tool that returns immediately has NO way to
 * deliver a later line to the model. `ryu-shell.ts` documents this at length
 * and answers with polling. A MONITOR has the opposite requirement — the whole
 * point is that lines arrive and the model reacts — so this file makes the
 * opposite choice, and both are right:
 *
 *   - `bash_background` is for work the model wants to CHECK ON LATER, so it
 *     returns instantly and is polled (`pull`).
 *   - `monitor` is for work the model wants to WATCH TO ITS END, so it stays
 *     open for the whole watch, streaming every line via `onUpdate`, and
 *     resolves only when the watch ends (`push`, bounded by a live call).
 *
 * `pi-subagent.ts` proves the shape works: its `Task` tool stays open for the
 * whole child run and streams progress through `onUpdate`. `monitor` is the
 * same pattern pointed at a child process or a WebSocket instead of a child
 * Pi. The turn IS held open for the watch's lifetime — that is the documented
 * contract of Claude Code's Monitor too, and it is why every watch carries a
 * `timeout_ms` deadline and why the tool description tells the model to bound
 * the command it watches.
 *
 * THE PI-SPECIFIC GAP `until` CLOSES
 * ----------------------------------
 * Claude Code feeds streamed monitor lines back to the model as they arrive,
 * so it can react mid-watch. Pi's agent loop cannot do that: the model only
 * sees the stream after the tool resolves (the updates are progress; the
 * final result is the record). "Tail a log and flag errors AS THEY APPEAR"
 * therefore cannot mean "react instantly" here — it has to mean "END the
 * watch the moment an error appears, then report". That is what the optional
 * `until` regex does: the watch stops the instant a line matches, and the
 * final result names the line that matched. It is the Pi answer to Claude's
 * mid-watch reaction, and it is why `until` exists even though Claude's tool
 * has no equivalent.
 *
 * WHY NOTHING HERE NEEDS CORE
 * ---------------------------
 * The tool name `monitor` is not in Core's `KNOWN_TOOLS`
 * (`sidecar/adapters/mod.rs::acp_tool_ui_name`), so it renders as an ordinary
 * dynamic tool row, exactly like `bash_background`/`bash_output`/`bash_kill`.
 * That is correct: the desktop has no special monitor card, and this tool
 * needs none. No Core or desktop change beyond the compiled-in manifest row.
 *
 * WHAT A CHILD INHERITS — AND WHAT A CHILD IS NOT ALLOWED
 * -------------------------------------------------------
 * The `RYU_PI_SUBAGENT` marker is set on every child `pi` spawned by
 * `ryu-subagent.ts`'s `Task` tool (a CROSS-FILE CONTRACT shared with
 * `ryu-shell.ts`). A child registers NO monitor, for two independent reasons.
 * Budget: a child is one non-interactive turn with no user to interrupt it, so
 * a model that calls `monitor` with a long `timeout_ms` inside a delegated job
 * would silently hold the PARENT's turn open for its whole duration — the one
 * thing a bounded subagent must never do. Usefulness: the parent can watch
 * anything the child can, so the capability costs nothing to lose. The factory
 * early-returns when the marker is set, exactly as `ryu-shell.ts` does.
 *
 * NO npm DEPENDENCIES, NO SIBLING FILES
 * -------------------------------------
 * Pi loads extensions through jiti with a CLOSED module set (the pi packages,
 * typebox, node built-ins). Everything below is node built-ins + typebox. The
 * WebSocket source uses the GLOBAL `WebSocket` (Node ≥ 21 / Bun), never a
 * package — `node:ws` would not resolve under jiti. The file reads the global
 * defensively and returns a clear error rather than assuming the runtime has
 * one.
 *
 * ORPHAN PREVENTION — THE LARGEST RISK IN THIS FILE
 * -------------------------------------------------
 * Unlike `ryu-shell.ts`'s shells, a monitor does not survive its turn: the
 * tool promise is the watch, and when Pi tears the process down the pending
 * call is aborted. The real orphan is the CHILD PROCESS of a command watch,
 * which on POSIX does not die because its parent did. Three defences:
 *   1. `stopAllMonitors()` from Pi's `session_shutdown`, AND defensively at
 *      the top of the factory (jiti can hand back a cached module whose
 *      module-level registry survived a reload — `ryu-shell.ts` and
 *      `ryu-lsp.ts` defend the same way for the same reason). This reaches
 *      far: Pi's rpc mode runs `shutdown()` from stdin end as well as SIGTERM,
 *      and `shutdown()` AWAITS `runtimeHost.dispose()`, which awaits every
 *      `session_shutdown` handler before `process.exit`.
 *   2. The timeout timer: every watch ends at `timeout_ms` whether or not the
 *      source cooperates, and the timer is `unref`'d so it never keeps Pi's
 *      event loop open.
 *   3. The abort ladder on the tool's `AbortSignal`: a cancelled turn
 *      SIGTERMs the child, then SIGKILLs it after `TERM_GRACE_MS`.
 * The residual window — Pi SIGKILLed outright, the timer and the registry both
 * dead inside it — is exactly `ryu-shell.ts`'s: a real bound has to live
 * INSIDE the spawned command (a ppid watchdog prefix), not in Pi. Not done
 * here; stated so nobody re-derives it as a surprise.
 *
 * `detached: false` is NOT a fourth defence, and must not be described as one
 * — the same reasoning `ryu-shell.ts` gives in its own preamble: nothing in
 * Ryu ever signals a process group, and on POSIX a child does not die because
 * its parent did.
 *
 * NEVER REGISTER A SLASH COMMAND
 * ------------------------------
 * `pi.registerCommand` is fatal over ACP: Pi's `AgentSession.prompt`
 * short-circuits a registered extension command before `_runAgentPrompt`, so
 * no `agent_end` is ever emitted and the ACP `session/prompt` request never
 * returns. This extension registers a tool and nothing else.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-monitor]";

/**
 * Hard cap on monitors running AT ONCE, counted over live monitors only.
 * A monitor holds the turn open, so one is the normal case; the second slot
 * exists for a command AND a WebSocket watched together (e.g. a server log
 * plus its health feed). Pi runs a message's tool calls concurrently, so the
 * cap is claimed atomically in the synchronous prefix of `execute` — a model
 * that emits three `monitor` calls in one message gets a clear "at cap" answer
 * on the third, never three silent parallel watches.
 */
const MAX_MONITORS = 2;

/**
 * Default lifetime cap. A monitor holds the turn open, so a watch with no
 * deadline can block the conversation for as long as the source lives. Five
 * minutes is enough for the real workloads (a build, a test run, a bounded
 * `tail`) and short enough that a forgotten watch returns the turn promptly.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Ceiling on `timeout_ms`, applied by clamping. */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Floor on `timeout_ms`, applied by clamping. */
const MIN_TIMEOUT_MS = 1000;

/** Grace between SIGTERM and SIGKILL when stopping a command watch. */
const TERM_GRACE_MS = 5000;

/**
 * Tail cap, in bytes, of the most recent output retained for the final
 * result. A long watcher can emit megabytes; the model only ever needs the
 * tail plus the summary. Dropped bytes are counted and reported — silently
 * handing the model a truncated log it believes is complete is the failure
 * this accounting exists to prevent (same posture as `ryu-shell.ts`'s ring
 * buffer).
 */
const TAIL_CAP_BYTES = 64 * 1024;

/** Ceiling on ONE streamed line in an `onUpdate` (a pathological minified
 *  line must not blow the wire in one event). The tail keeps the full line. */
const MAX_LINE_UPDATE_CHARS = 16 * 1024;

/** Ceiling on one coalesced `onUpdate` batch. */
const MAX_UPDATE_CHARS = 32 * 1024;

/** Bound model-supplied regex syntax and the text any one regex sees. Native
 * RegExp runs synchronously, so an unsafe pattern can otherwise block the event
 * loop before the watch timeout has a chance to fire. */
const MAX_UNTIL_PATTERN_CHARS = 256;
const MAX_RETAINED_LINE_CHARS = 16 * 1024;

/**
 * WebSocket messages larger than this end the watch (Claude Code's monitor
 * behaves the same way); the caller sees a closing summary, not the payload.
 */
const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

/** Monitor id prefix. Short, greppable, and obviously not a pid. */
const MONITOR_ID_PREFIX = "mn_";

/** Recursion marker set by `ryu-subagent.ts`; a shared CROSS-FILE contract. */
const SUBAGENT_MARKER = "RYU_PI_SUBAGENT";

// ── Small helpers ───────────────────────────────────────────────────────────

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The reason channel. Visible when Pi is run standalone; DISCARDED under Ryu,
 * because pi-acp sinks its child's stderr into a no-op handler (see the
 * preamble of `ryu-shell.ts`). A debugging aid, never a record.
 */
function log(message: string): void {
	try {
		process.stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		// A closed stderr must never break a turn.
	}
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

/**
 * Clamp a caller-supplied `timeout_ms` into the accepted range. A non-number
 * resolves to the default; anything below the floor or above the ceiling is
 * clamped rather than rejected so a model guessing wildly at units still gets
 * a working watch.
 */
function clampTimeout(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(raw)));
}

/**
 * Compile an `until` value into a RegExp, accepting either a bare pattern
 * (`error`) or a `/pattern/flags` literal. Resets `lastIndex` before every
 * test so a global pattern cannot flip-flop across lines.
 */
function compileUntil(raw: string | undefined): RegExp | undefined {
	if (!raw) {
		return undefined;
	}
	const literal = raw.match(/^\/([\s\S]*)\/([a-z]*)$/);
	const source = literal ? literal[1] : raw;
	const flags = literal ? literal[2] : "";
	if (source.length > MAX_UNTIL_PATTERN_CHARS) {
		throw new Error(
			`monitor: \`until\` regex is ${source.length} characters (max ${MAX_UNTIL_PATTERN_CHARS})`
		);
	}
	if (/[()]/.test(source) || /\\[1-9]/.test(source)) {
		throw new Error(
			"monitor: `until` uses a grouped or backreference expression; use the safe subset (literals, classes, alternation, anchors, and simple quantifiers)"
		);
	}
	if (/[^imsu]/.test(flags)) {
		throw new Error("monitor: `until` flags may contain only i, m, s, or u");
	}
	try {
		const re = new RegExp(source, flags);
		re.lastIndex = 0;
		return re;
	} catch (err) {
		throw new Error(
			`monitor: invalid \`until\` regex ${JSON.stringify(raw)}: ${errorText(err)}`
		);
	}
}

/**
 * Reject WebSocket URLs that carry credentials, whitespace or non-ASCII
 * characters, or that point at link-local / cloud-metadata addresses.
 *
 * This is a CHEAP guard, not a boundary, and it must not be described as one:
 * the command source already runs with the agent's full network access, so a
 * would-be SSRF probe needs no WebSocket at all. What the guard actually
 * prevents is the specific footgun of an extension that exists to CONNECT
 * somewhere: the 169.254.0.0/16 (link-local, which contains cloud metadata
 * 169.254.169.254) block is enforced on literal IPs so a model in a retry loop
 * cannot be aimed at the host's metadata endpoint on the one path designed for
 * inbound connections. Loopback and private ranges are ALLOWED — a local dev
 * server's ws feed is a legitimate watch target, and the command path has no
 * such restriction anyway. Hostnames are not resolved here (that would block
 * the turn on DNS); a hostname that happens to resolve to link-local is out of
 * scope and documented as such.
 */
function validateWsUrl(raw: string): string {
	const url = raw.trim();
	if (!/^wss?:\/\/\S+$/.test(url)) {
		throw new Error(
			`monitor: ws.url must be a ws:// or wss:// URL with no whitespace, got ${JSON.stringify(raw)}`
		);
	}
	for (let i = 0; i < url.length; i++) {
		if (url.charCodeAt(i) > 0x7f) {
			throw new Error("monitor: ws.url must use ASCII characters only");
		}
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (err) {
		throw new Error(`monitor: invalid ws.url: ${errorText(err)}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("monitor: ws.url must not embed credentials");
	}
	const host = parsed.hostname.toLowerCase();
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const octets = v4.slice(1).map(Number);
		if (
			octets.every((n) => n >= 0 && n <= 255) &&
			octets[0] === 169 &&
			octets[1] === 254
		) {
			throw new Error(
				"monitor: ws.url targets a link-local / cloud-metadata address (169.254.0.0/16)"
			);
		}
	}
	return url;
}

// ── Line pipeline ───────────────────────────────────────────────────────────

/**
 * The single funnel both sources pour into. Owns:
 *   - incremental UTF-8 decoding (`StringDecoder`) so a multi-byte character
 *     split across chunks never corrupts,
 *   - a byte-capped, whole-line TAIL retained for the final result,
 *   - a COALESCING `onUpdate` stream — lines that arrive in the same tick are
 *     batched into one event, so a chatty process becomes a handful of wire
 *     events while a quiet one still delivers each line promptly,
 *   - the `until` match check (ending the watch is the controller's job).
 */
interface LineSink {
	/** Feed a raw chunk from a byte stream (decoded incrementally). */
	chunk: (chunk: string) => void;
	/** Bytes discarded by the tail cap, reported in the final result. */
	dropped: number;
	/** Count of lines delivered, for the summary. */
	events: number;
	/** Flush a trailing partial line; idempotent. */
	finish: () => void;
	/** Lines retained for the final result's tail, oldest first. */
	lines: string[];
	/** Append one already-whole line. */
	push: (line: string) => void;
}

function makeLineSink(
	onEvent: (text: string) => void,
	onMatch: (line: string) => void,
	until: RegExp | undefined
): LineSink {
	const lines: string[] = [];
	let bytes = 0;
	let dropped = 0;
	let events = 0;
	let closed = false;
	// Trailing text of the last decoded chunk that did not end in a newline;
	// carried across chunks and flushed by `finish`.
	let partial = "";

	const pending: string[] = [];
	let scheduled = false;

	const handle = (line: string): string => {
		const originalBytes = Buffer.byteLength(line, "utf8");
		const retained =
			line.length > MAX_RETAINED_LINE_CHARS
				? line.slice(-MAX_RETAINED_LINE_CHARS)
				: line;
		const retainedBytes = Buffer.byteLength(retained, "utf8");
		dropped += originalBytes - retainedBytes;
		events++;
		lines.push(retained);
		bytes += retainedBytes;
		while (bytes > TAIL_CAP_BYTES && lines.length > 1) {
			const evicted = lines.shift() ?? "";
			bytes -= Buffer.byteLength(evicted, "utf8");
			dropped += Buffer.byteLength(evicted, "utf8");
		}
		if (until) {
			until.lastIndex = 0;
			if (until.test(retained)) {
				onMatch(retained);
			}
		}
		return retained;
	};

	const flush = (): void => {
		scheduled = false;
		if (pending.length === 0) {
			return;
		}
		const batch: string[] = [];
		let len = 0;
		while (pending.length > 0) {
			const line = pending[0];
			const capped =
				line.length > MAX_LINE_UPDATE_CHARS
					? `${line.slice(0, MAX_LINE_UPDATE_CHARS)}…`
					: line;
			const nextLen =
				batch.length === 0 ? capped.length : len + 1 + capped.length;
			if (nextLen > MAX_UPDATE_CHARS) {
				break;
			}
			pending.shift();
			batch.push(capped);
			len = nextLen;
		}
		if (batch.length > 0) {
			onEvent(batch.join("\n"));
		}
		if (pending.length > 0) {
			scheduleFlush();
		}
	};

	const scheduleFlush = (): void => {
		if (scheduled) {
			return;
		}
		scheduled = true;
		queueMicrotask(flush);
	};

	const decoder = new StringDecoder("utf8");

	return {
		get dropped() {
			return dropped;
		},
		get events() {
			return events;
		},
		lines,
		chunk: (chunk) => {
			if (closed) {
				return;
			}
			const decoded = `${partial}${decoder.write(chunk)}`;
			const fragments = decoded.split("\n");
			const complete = fragments.slice(0, -1);
			for (const fragment of complete) {
				pending.push(handle(fragment));
			}
			scheduleFlush();
			partial = fragments.at(-1) ?? "";
			if (partial.length > MAX_RETAINED_LINE_CHARS) {
				const retained = partial.slice(-MAX_RETAINED_LINE_CHARS);
				dropped +=
					Buffer.byteLength(partial, "utf8") -
					Buffer.byteLength(retained, "utf8");
				partial = retained;
			}
		},
		push: (line) => {
			if (closed) {
				return;
			}
			pending.push(handle(line));
			scheduleFlush();
		},
		finish: () => {
			if (closed) {
				return;
			}
			closed = true;
			const tailDecoder = decoder.end();
			const last = tailDecoder ? `${partial}${tailDecoder}` : partial;
			if (last) {
				pending.push(handle(last));
			}
			flush();
		},
	};
}

export { compileUntil, makeLineSink };

// ── Command source ──────────────────────────────────────────────────────────

interface CommandConfig {
	command: string;
	cwd: string;
	description: string | undefined;
}

/** How a source ended by itself. */
interface WatchOutcome {
	closeCode?: number;
	closeReason?: string;
	ended: "exited" | "closed" | "error";
	error?: string;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
}

/** Why the extension stopped the watch, when it stopped it itself. */
type StopReason = "timeout" | "matched" | "aborted" | "teardown";

interface WatchHandle {
	done: Promise<WatchOutcome>;
	stop: (reason?: StopReason) => void;
}

/**
 * Spawn the watched command, split its stdout+stderr into lines, and stream
 * them. `done` resolves when the process exits or fails to spawn. `stop()` is
 * SIGTERM then SIGKILL after a grace period — the same ladder `ryu-shell.ts`
 * uses, and just as best-effort for the grandchildren of a compound command
 * (prefer one command per watch; document rather than detach).
 */
function startCommandWatch(config: CommandConfig, sink: LineSink): WatchHandle {
	let settled = false;
	let resolveDone: (outcome: WatchOutcome) => void;
	const done = new Promise<WatchOutcome>((resolve) => {
		resolveDone = resolve;
	});

	let graceTimer: ReturnType<typeof setTimeout> | undefined;

	const child = spawn(config.command, {
		cwd: config.cwd,
		detached: false,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	const settle = (outcome: WatchOutcome): void => {
		if (settled) {
			return;
		}
		settled = true;
		if (graceTimer) {
			clearTimeout(graceTimer);
		}
		child.removeAllListeners();
		resolveDone(outcome);
	};

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => sink.chunk(chunk));
	child.stderr?.on("data", (chunk: string) => sink.chunk(chunk));

	child.on("error", (err) => {
		// A spawn failure (bad cwd, no shell) surfaces asynchronously; without a
		// handler it is fatal to Pi. It becomes a visible line AND the outcome.
		sink.push(`${LOG_PREFIX} spawn failed: ${errorText(err)}`);
		settle({
			ended: "error",
			error: errorText(err),
			exitCode: null,
			exitSignal: null,
		});
	});
	child.on("exit", (code, signal) => {
		sink.finish();
		settle({ ended: "exited", exitCode: code, exitSignal: signal });
	});

	const stop = (_reason?: StopReason): void => {
		if (settled) {
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			// Already reaped; `exit` will fire and settle.
			return;
		}
		try {
			child.kill("SIGTERM");
		} catch {
			// Already reaped between the check and the call.
			return;
		}
		graceTimer = setTimeout(() => {
			if (!settled) {
				try {
					child.kill("SIGKILL");
				} catch {
					// Reaped in the meantime.
				}
			}
		}, TERM_GRACE_MS);
		graceTimer.unref?.();
	};

	return { done, stop };
}

// ── WebSocket source ────────────────────────────────────────────────────────

/**
 * The subset of the DOM `WebSocket` surface this file uses, stated structurally
 * so the file compiles without a DOM lib. The runtime's real global satisfies
 * it (Node ≥ 21's undici WebSocket and Bun's both do).
 */
interface WsSocket {
	close: (code?: number, reason?: string) => void;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onopen: (() => void) | null;
}

type WsConstructor = new (
	url: string,
	protocols?: string[] | string
) => WsSocket;

function binarySize(data: unknown): number {
	if (data && typeof data === "object") {
		const candidate = data as { byteLength?: number; size?: number };
		if (typeof candidate.byteLength === "number") {
			return candidate.byteLength;
		}
		if (typeof candidate.size === "number") {
			return candidate.size;
		}
	}
	return 0;
}

/**
 * Watch a WebSocket feed: each text message becomes one line (even when it
 * spans lines — the message is a single event), binary frames become a
 * placeholder line, and a message larger than `MAX_WS_MESSAGE_BYTES` ends the
 * watch. `done` resolves when the socket closes or errors; `stop()` requests a
 * clean close.
 */
function startWsWatch(
	config: { url: string; protocols: string[] | undefined },
	sink: LineSink
): WatchHandle {
	let settled = false;
	let socket: WsSocket | undefined;
	let resolveDone: (outcome: WatchOutcome) => void;
	const done = new Promise<WatchOutcome>((resolve) => {
		resolveDone = resolve;
	});

	const settle = (outcome: WatchOutcome): void => {
		if (settled) {
			return;
		}
		settled = true;
		resolveDone(outcome);
	};

	const WsCtor = (globalThis as { WebSocket?: WsConstructor }).WebSocket;
	if (typeof WsCtor !== "function") {
		settle({
			ended: "error",
			error:
				"this runtime has no global WebSocket; the ws source needs Node ≥ 21 or Bun",
			exitCode: null,
			exitSignal: null,
		});
		return {
			done,
			stop: () => {
				// Nothing connected; there is nothing to stop.
			},
		};
	}

	try {
		socket = new WsCtor(
			config.url,
			config.protocols && config.protocols.length > 0
				? config.protocols
				: undefined
		);
	} catch (err) {
		settle({
			ended: "error",
			error: errorText(err),
			exitCode: null,
			exitSignal: null,
		});
		return {
			done,
			stop: () => {
				// Failed to construct; nothing to stop.
			},
		};
	}

	function stop(): void {
		if (settled) {
			return;
		}
		try {
			socket?.close(1000, "monitor ended");
		} catch {
			// Already closed between the check and the call; `onclose` settles.
		}
	}

	socket.onopen = () => {
		log(`${config.url}: connected`);
	};
	socket.onmessage = (event) => {
		if (settled) {
			return;
		}
		const data = event.data;
		if (typeof data === "string") {
			if (Buffer.byteLength(data, "utf8") > MAX_WS_MESSAGE_BYTES) {
				sink.push(
					`${LOG_PREFIX} message exceeded ${MAX_WS_MESSAGE_BYTES} bytes; ending the watch`
				);
				stop();
				return;
			}
			sink.push(data);
			return;
		}
		// Binary frames are summarized, never passed through (same posture as
		// Claude Code's monitor: a placeholder line instead of the payload).
		sink.push(`[binary frame, ${binarySize(data)} bytes]`);
	};
	// An error is recorded, NOT terminal: undici always follows `onerror` with
	// `onclose` (code 1006 for an abnormal closure), and `onclose` is the single
	// terminal event — a dropped connection is a "socket closed (code 1006)"
	// outcome that still carries every message already received.
	let wsError: string | undefined;
	socket.onerror = () => {
		wsError = "websocket error";
	};
	socket.onclose = (event) => {
		sink.finish();
		const abnormal = event.code === 1006 || wsError !== undefined;
		settle({
			ended: "closed",
			closeCode: event.code,
			closeReason: event.reason,
			error: abnormal
				? (wsError ?? `websocket closed abnormally (code ${event.code})`)
				: undefined,
			exitCode: null,
			exitSignal: null,
		});
	};

	return { done, stop };
}

// ── Tool result assembly ────────────────────────────────────────────────────

type WatchConfig =
	| {
			description?: string;
			timeoutMs: number;
			type: "command";
			command: string;
			cwd: string;
	  }
	| {
			description?: string;
			timeoutMs: number;
			type: "ws";
			url: string;
			protocols?: string[];
	  };

interface MonitorDetails {
	close_code?: number;
	close_reason?: string;
	command?: string;
	cwd?: string;
	description?: string;
	dropped_bytes: number;
	elapsed_ms: number;
	error?: string;
	events: number;
	exit_code: number | null;
	exit_signal: NodeJS.Signals | null;
	matched_line?: string;
	monitor_id: string;
	reason: string;
	source_type: "command" | "ws";
	stop_reason?: string;
	tail_chars: number;
	timeout_ms: number;
	until?: string;
	ws_protocols?: string[];
	ws_url?: string;
}

function buildDetails(monitorId: string, cfg: WatchConfig): MonitorDetails {
	const base: MonitorDetails = {
		dropped_bytes: 0,
		elapsed_ms: 0,
		events: 0,
		exit_code: null,
		exit_signal: null,
		monitor_id: monitorId,
		reason: "running",
		source_type: cfg.type,
		tail_chars: 0,
		timeout_ms: cfg.timeoutMs,
	};
	if (cfg.type === "command") {
		base.command = cfg.command;
		base.cwd = cfg.cwd;
	} else {
		base.ws_url = cfg.url;
		if (cfg.protocols) {
			base.ws_protocols = cfg.protocols;
		}
	}
	if (cfg.description) {
		base.description = cfg.description;
	}
	return base;
}

/** Resolve a caller-supplied cwd against the session cwd, confirming it is a
 *  directory BEFORE spawning — a bad cwd otherwise surfaces as an async spawn
 *  error and the watch reports success for a process that never ran. */
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

// ── Watch orchestration ─────────────────────────────────────────────────────

interface ActiveMonitor {
	done: Promise<void>;
	id: string;
	/** Assigned by `runWatch` once the underlying watch exists; what makes
	 *  `stopAllMonitors` able to actually STOP a live watch rather than merely
	 *  await it. */
	stop: (reason: StopReason) => void;
}

/** Module-level registry — what `session_shutdown` (and the reload defence)
 *  iterate over to stop anything still running. */
let monitors = new Map<string, ActiveMonitor>();

/** Monotonic id source. Never reset, so an id is never reused. */
let nextMonitorId = 1;

function liveMonitorCount(): number {
	return monitors.size;
}

/** Claim a `MAX_MONITORS` slot. Same check-and-register-in-one-synchronous-run
 *  discipline as `ryu-shell.ts`'s `reserveShell`; Pi runs a message's tool
 *  calls concurrently, so the cap must be enforced without an interleaving
 *  `await`. */
function reserveMonitor(monitor: ActiveMonitor): boolean {
	if (liveMonitorCount() >= MAX_MONITORS) {
		return false;
	}
	monitors.set(monitor.id, monitor);
	return true;
}

function releaseMonitor(id: string): void {
	monitors.delete(id);
}

/** Stop everything still running and empty the registry. Idempotent, matching
 *  `ryu-shell.ts`'s `stopAllShells`: `session_shutdown` may be delivered more
 *  than once, and the factory calls this defensively against a jiti-cached
 *  module whose registry survived a reload. */
async function stopAllMonitors(reason: StopReason): Promise<void> {
	const entries = [...monitors.values()];
	monitors = new Map();
	await Promise.all(
		entries.map((monitor) => {
			try {
				monitor.stop(reason);
			} catch {
				// A stop must never turn teardown into a rejection.
			}
			return monitor.done.catch(() => undefined);
		})
	);
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Tear down anything a previous bind left behind (a jiti-cached module
	// whose registry survived a reload), same as `ryu-shell.ts`.
	if (monitors.size > 0) {
		stopAllMonitors("teardown").catch(() => {
			// Best effort; the empty registry installed above is what matters.
		});
	}

	// A subagent child (`ryu-subagent.ts` spawns `pi --mode json -p` with this
	// marker set) registers NO monitor. See the preamble: a child has no user to
	// interrupt it, so a long `monitor` call inside a delegated job would hold
	// the parent's turn open for its whole duration.
	if (process.env[SUBAGENT_MARKER] === "1") {
		log("running as a subagent child; the monitor tool is not registered");
		return;
	}

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: [
			"Watch a command or WebSocket feed and stream every line as it arrives, ending the watch when the source ends, a matching line appears, or the timeout fires.",
			"Use it to tail a log and flag errors, watch a build or test run to completion, or follow a WebSocket feed. While the watch runs the turn is held open, so prefer a bounded command (e.g. `timeout 30 tail -f app.log`) or pass `timeout_ms`, and use `until` to end the watch the moment the event you care about appears.",
			"Pass exactly one source: `command` (a shell command, run in `cwd`) or `ws.url` (a ws:// or wss:// feed; each message becomes one line).",
			`Ends by default after ${formatDuration(DEFAULT_TIMEOUT_MS)}; ` +
				`timeout_ms is clamped to [${formatDuration(MIN_TIMEOUT_MS)}, ${formatDuration(MAX_TIMEOUT_MS)}]. ` +
				`At most ${MAX_MONITORS} watches may run at once.`,
		].join(" "),
		promptSnippet: "Watch a command or stream and react when it changes",
		promptGuidelines: [
			"monitor holds the turn open until the watch ends, so bound every watch: prefer a command that exits on its own (a build, a bounded `timeout N tail -f ...`) or pass a `timeout_ms`. A watch left unbounded blocks the conversation for its whole lifetime.",
			"You cannot react to a streamed line until the watch ends, so when you need to act on an event, use `until` with a regex matching the line you care about — the watch stops the moment it matches and reports the line.",
			"Each monitor call is one watch; the result gives you the tail plus a summary, not the whole stream. For output you must re-read across turns, use bash_background (pi-shell) and poll it instead.",
			"The ws source is for servers that already push events; for everything else a command is simpler and needs no special runtime support.",
		],
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description:
						"The shell command to watch, e.g. `timeout 60 npm run build` or `tail -f app.log`. Mutually exclusive with ws.",
				})
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Directory to run the command in. Relative paths resolve against the session's working directory. Defaults to it.",
				})
			),
			ws: Type.Optional(
				Type.Object({
					url: Type.String({
						description:
							"A ws:// or wss:// endpoint to connect to; each incoming message becomes one line.",
					}),
					protocols: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"WebSocket subprotocols to offer during the handshake.",
						})
					),
				})
			),
			until: Type.Optional(
				Type.String({
					description:
						"A regular expression. The watch ends the moment a line matches it, and the result reports which line matched. Use it to stop the moment an error appears, a build reports success, etc.",
				})
			),
			timeout_ms: Type.Optional(
				Type.Integer({
					description: `Lifetime cap for the watch in milliseconds. Default ${formatDuration(DEFAULT_TIMEOUT_MS)}, clamped to [${formatDuration(MIN_TIMEOUT_MS)}, ${formatDuration(MAX_TIMEOUT_MS)}].`,
				})
			),
			description: Type.Optional(
				Type.String({
					description:
						"Short human-readable label for this watch, e.g. `dev server log`.",
				})
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const id = `${MONITOR_ID_PREFIX}${nextMonitorId}`;
			nextMonitorId += 1;

			// Validate the source up front so a malformed call fails fast with a
			// reason the model can read, before anything is spawned. The two
			// branches below are deliberately shaped so TypeScript narrows
			// `wsRaw` to defined in the WebSocket arm.
			const command =
				typeof params?.command === "string" ? params.command.trim() : "";
			const wsRaw = params?.ws as
				| { url?: unknown; protocols?: unknown }
				| undefined;
			const hasWs = Boolean(wsRaw && typeof wsRaw.url === "string");
			if (command && hasWs) {
				throw new Error(
					"monitor: pass exactly one source — pass `command` OR `ws.url`, not both."
				);
			}
			if (!(command || hasWs)) {
				throw new Error(
					"monitor: pass exactly one source — either `command` or `ws.url`."
				);
			}
			const until = compileUntil(
				typeof params?.until === "string" && params.until.trim()
					? params.until.trim()
					: undefined
			);
			const timeoutMs = clampTimeout(params?.timeout_ms);
			const description =
				typeof params?.description === "string"
					? params.description.trim() || undefined
					: undefined;

			let cfg: WatchConfig;
			if (command) {
				const cwd = await resolveCwd(params?.cwd, ctx.cwd);
				cfg = { type: "command", command, cwd, description, timeoutMs };
			} else if (wsRaw) {
				const wsUrl = validateWsUrl(wsRaw.url as string);
				const protocols = Array.isArray(wsRaw?.protocols)
					? wsRaw.protocols.filter(
							(p): p is string => typeof p === "string" && p.length > 0
						)
					: undefined;
				cfg = {
					type: "ws",
					url: wsUrl,
					protocols: protocols && protocols.length > 0 ? protocols : undefined,
					description,
					timeoutMs,
				};
			} else {
				// Unreachable: the two guards above already threw for this state.
				// Present so `cfg` is definitely assigned in every path.
				throw new Error(
					"monitor: pass exactly one source — either `command` or `ws.url`."
				);
			}

			// Claim a slot BEFORE any await so two concurrent calls cannot both
			// pass the cap check (Pi runs a message's tool calls concurrently).
			// `stop` is filled in by `runWatch` once the underlying watch exists.
			const monitor: ActiveMonitor = {
				id,
				done: Promise.resolve(),
				stop: () => {
					// Nothing to stop yet; assigned before any await in runWatch.
				},
			};
			if (!reserveMonitor(monitor)) {
				return {
					content: [
						{
							type: "text",
							text: `Too many monitors are already running (max ${MAX_MONITORS}). Stop one or wait for it to finish, then try again.`,
						},
					],
					details: { ...buildDetails(id, cfg), reason: "at-cap" },
				};
			}

			try {
				return await runWatch(id, cfg, monitor, {
					until,
					untilRaw: params?.until,
					onUpdate,
					signal,
				});
			} finally {
				releaseMonitor(id);
			}
		},
	});

	// Fires for `quit` AND for session replacement (`new` / `resume` / `fork`).
	// Not guaranteed to arrive at all — Core's pool and pi-acp's `closeAllExcept`
	// both kill Pi outright — which is precisely why it is the last defence
	// rather than the only one (the timeout timer is the first).
	pi.on("session_shutdown", async () => {
		await stopAllMonitors("teardown");
	});
}

interface RunWatchArgs {
	onUpdate?:
		| ((partial: {
				content: { type: "text"; text: string }[];
				details: MonitorDetails;
		  }) => void)
		| undefined;
	signal?: AbortSignal;
	until?: RegExp;
	untilRaw?: unknown;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: MonitorDetails;
}

async function runWatch(
	id: string,
	cfg: WatchConfig,
	monitor: ActiveMonitor,
	args: RunWatchArgs
): Promise<ToolResult> {
	const { until, untilRaw, signal, onUpdate } = args;
	const startedAt = Date.now();

	let stopReason: StopReason | undefined;
	let matchedLine: string | undefined;

	// The controller's own stop wrapper: record WHY, then delegate to the
	// source. Recording before delegating matters — once the source has
	// settled (exited on its own) the delegate is a no-op, and the reason the
	// model needs ("reached the timeout", "matched until …") must survive that.
	// `underlyingStop` is a placeholder until the real watch exists below; the
	// gap is bounded by the fact that no await precedes its assignment.
	let underlyingStop: WatchHandle["stop"] = () => {
		// Filled in with the real watch below.
	};
	const requestStop = (reason: StopReason): void => {
		if (!stopReason) {
			stopReason = reason;
		}
		underlyingStop();
	};
	monitor.stop = requestStop;

	const sink = makeLineSink(
		(text) => {
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text }],
					details: snapshot(),
				});
			}
		},
		(line) => {
			matchedLine = line;
			requestStop("matched");
		},
		until
	);

	const snapshot = (): MonitorDetails => {
		const base = buildDetails(id, cfg);
		base.dropped_bytes = sink.dropped;
		base.elapsed_ms = Date.now() - startedAt;
		base.events = sink.events;
		base.matched_line = matchedLine;
		base.reason = stopReason ?? "running";
		base.stop_reason = stopReason;
		base.tail_chars = Buffer.byteLength(sink.lines.join(""), "utf8");
		if (untilRaw !== undefined) {
			base.until = String(untilRaw);
		}
		return base;
	};

	let abortHappened = false;
	const abortHandler = (): void => {
		abortHappened = true;
		requestStop("aborted");
	};
	if (signal) {
		if (signal.aborted) {
			abortHappened = true;
		} else {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	const timeoutTimer = setTimeout(() => {
		requestStop("timeout");
	}, cfg.timeoutMs);
	timeoutTimer.unref?.();

	let outcome: WatchOutcome;
	if (cfg.type === "command") {
		const handle = startCommandWatch(
			{ command: cfg.command, cwd: cfg.cwd, description: cfg.description },
			sink
		);
		underlyingStop = handle.stop;
		// The registry's `done` must be the REAL watch promise, not the
		// placeholder from `execute` — `stopAllMonitors` awaits it so teardown
		// actually waits for the child to die before Pi exits.
		monitor.done = handle.done.then(() => undefined);
		outcome = await handle.done;
	} else {
		const handle = startWsWatch(
			{ url: cfg.url, protocols: cfg.protocols ?? undefined },
			sink
		);
		underlyingStop = handle.stop;
		monitor.done = handle.done.then(() => undefined);
		outcome = await handle.done;
	}

	clearTimeout(timeoutTimer);
	if (signal) {
		signal.removeEventListener("abort", abortHandler);
	}
	if (abortHappened) {
		throw new Error("Monitor was aborted");
	}

	const elapsed = formatDuration(Date.now() - startedAt);
	const source =
		cfg.type === "command" ? `command: ${cfg.command}` : `ws: ${cfg.url}`;

	const reasonLine =
		stopReason === "matched"
			? `matched until ${JSON.stringify(untilRaw)} on line: ${matchedLine ?? ""}`
			: stopReason === "timeout"
				? `reached the ${formatDuration(cfg.timeoutMs)} timeout`
				: outcome.ended === "exited"
					? `exited with code ${outcome.exitCode ?? 0}${
							outcome.exitSignal ? ` (${outcome.exitSignal})` : ""
						}`
					: outcome.ended === "closed"
						? `socket closed${outcome.closeCode ? ` (code ${outcome.closeCode})` : ""}${
								outcome.closeReason ? ` — ${outcome.closeReason}` : ""
							}${outcome.error ? ` — ${outcome.error}` : ""}`
						: `ended with an error${outcome.error ? `: ${outcome.error}` : ""}`;

	sink.finish();

	const details = snapshot();
	details.reason = stopReason ?? outcome.ended;
	details.exit_code = outcome.exitCode;
	details.exit_signal = outcome.exitSignal;
	details.close_code = outcome.closeCode;
	details.close_reason = outcome.closeReason;
	details.error = outcome.error;

	const tailText = sink.lines.join("\n");
	const tailBytes = Buffer.byteLength(tailText, "utf8");
	const tailLabel =
		sink.dropped > 0
			? `--- tail (last ${tailBytes} bytes; dropped ${sink.dropped} earlier bytes) ---`
			: `--- tail (last ${tailBytes} bytes) ---`;

	const text = [
		`Monitor ${id} ended after ${elapsed} — ${reasonLine}`,
		source,
		`events: ${sink.events}`,
		tailText ? tailLabel : "--- no output seen ---",
		...tailText.split("\n"),
	].join("\n");

	return { content: [{ type: "text", text }], details };
}
