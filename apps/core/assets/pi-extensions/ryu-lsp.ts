/**
 * Ryu LSP bridge — a Pi extension that gives the flagship, managed "ryu" (Pi)
 * agent language-server awareness.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi has no LSP support of its own. Claude Code does, and its model is the one
 * we copy VERBATIM so a config written for either host works in both: a plugin
 * declares language servers, the HOST spawns them. The declaration is a map of
 * server id -> config, with camelCase field names identical to Claude Code's
 * `.lsp.json` / `lspServers`:
 *
 *   { "go": { "command": "gopls", "args": ["serve"],
 *             "extensionToLanguage": { ".go": "go" } } }
 *
 * REQUIRED: `command` (a binary that must be on PATH) and `extensionToLanguage`.
 * OPTIONAL: `args`, `transport`, `env`, `initializationOptions`, `settings`,
 * `workspaceFolder`, `startupTimeout`, `shutdownTimeout`, `restartOnCrash`,
 * `maxRestarts`, `diagnostics`.
 *
 * The three Claude Code semantics that are load-bearing and are implemented
 * here exactly:
 *   - The declaration ships CONFIG ONLY, never the server binary. A missing
 *     binary is a graceful skip with a VISIBLE REASON, never a hard failure.
 *   - FIRST REGISTRATION WINS per file extension. If two enabled servers both
 *     claim ".go", the first one registered handles it, the others never start
 *     for it, and we emit a warning naming the owner.
 *   - A server with invalid config (no `command`, or no `extensionToLanguage`)
 *     is SKIPPED; the other servers still start, and the skipped server does
 *     NOT claim its extensions.
 *
 * WHERE THE CONFIG COMES FROM (and why it is a sibling file, not an env var)
 * -------------------------------------------------------------------------
 * Core writes the RESOLVED, agent-bound declaration to
 * `<agentDir>/extensions/ryu-lsp.json`, next to this file. We locate `<agentDir>`
 * through `PI_CODING_AGENT_DIR`, which Core sets on the Pi spawn command and
 * pi-acp forwards to the pi child unchanged.
 *
 * It is deliberately NOT an env var carrying inline JSON. Core interpolates env
 * values UNESCAPED into a single command String that the ACP client re-parses
 * with `shell_words::split`; a JSON blob's quotes are quote delimiters there and
 * would be stripped, and on Windows the same string is chained through cmd.exe
 * where `&`, `"`, `^`, `<` and `>` are metacharacters. It is also not an HTTP
 * fetch from Core: the config is Core-authored and would only add a round trip
 * to the critical path to first token.
 *
 * ABSENT OR EMPTY CONFIG === COMPLETE NO-OP. This is the single most important
 * robustness property of this file. No config file, an unreadable one, a
 * malformed one, or one that declares zero usable servers all take the same
 * path: register nothing at all — no tools, no `tool_result` handler, no
 * lifecycle handlers — and return. Pi must start normally with zero LSP servers
 * configured, and four dead `lsp_*` tool schemas would be a prompt-budget cost
 * for no benefit.
 *
 * NO NPM DEPENDENCIES
 * -------------------
 * Pi loads extensions through jiti with a CLOSED module set (the pi packages,
 * typebox, and the legacy aliases). There is no `vscode-jsonrpc` and no
 * `vscode-languageserver-protocol` to import, and adding a `package.json` next
 * to this file would break under Pi's standalone-binary loader, which resolves
 * bare specifiers to nothing at all. So the LSP client below is hand-rolled:
 * `node:child_process.spawn` plus manual `Content-Length: N\r\n\r\n` framing.
 * Node built-ins are available and are the only other runtime imports.
 *
 * LIFECYCLE DISCIPLINE
 * --------------------
 * Extension factories run in invocations that never start a session, so the
 * factory starts NO background resources. Servers are spawned lazily, the first
 * time a file with a claimed extension is actually touched, and torn down from
 * an idempotent `session_shutdown`. Cleanup must handle session REPLACEMENT
 * (`new` / `resume` / `fork`), not just `quit`: pi-acp spawns a fresh Pi RPC
 * process per `session/new` — one per chat turn — so a leaked `gopls` would
 * multiply once per turn.
 *
 * THE REASON CHANNEL IS STDERR
 * ----------------------------
 * `ctx.ui.notify` is not sufficient for the "visible reason" a graceful skip
 * owes the user: over ACP the managed Pi is frequently headless, where the UI
 * methods are no-ops. Core logs the ACP subprocess's stderr at WARN under the
 * `acp_subprocess` target, so stderr is the channel that always survives. The
 * `session_start` status line is decoration layered on top of it. We use no
 * interactive UI method (`select` / `confirm` / `input` / `editor`) at all —
 * those block on a human answering, and would hang a headless turn until
 * timeout rather than fail open.
 */

import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isEditToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-lsp]";

/** Key for this extension's footer status slot. */
const RYU_LSP_UI_KEY = "ryu-lsp";

/** Header/body separator of the LSP base protocol. */
const HEADER_TERMINATOR = "\r\n\r\n";

/**
 * Content-Length matcher, hoisted to module scope because the framing loop runs
 * once per frame on every stdout chunk and a literal there would recompile the
 * pattern each time.
 */
const CONTENT_LENGTH_RE = /content-length:\s*(\d+)/i;

/**
 * Ceiling on a single frame's advertised body size, above which we treat the
 * header as garbage rather than as a body we have not finished receiving.
 *
 * Without it, `Content-Length: 999999999999` is indistinguishable from a frame
 * still in flight: the loop returns to wait for a body that will never arrive,
 * every later chunk is appended behind it, and the buffer grows without bound
 * until the agent process dies of memory exhaustion. A desynchronised stream is
 * the likely cause in practice (a server writing a log line to stdout), and the
 * NaN branch below already treats that as "resynchronise", so this routes an
 * absurd length to the same recovery instead of to an OOM.
 *
 * 64 MiB is far above any real LSP payload — the largest legitimate frames are
 * whole-file semantic-token responses on huge files, orders of magnitude under
 * this — so the cap can only fire on corruption, never on a valid server.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Fallbacks for the optional timing/restart fields, applied when the
 * declaration omits them.
 *
 * `shutdownTimeout` is a DELIBERATE, documented deviation from Claude Code,
 * whose reference says "when unset, no timeout applies" — i.e. it waits on a
 * clean `shutdown`/`exit` indefinitely. We cannot: a wedged language server that
 * never answers `shutdown` would hold Pi's teardown open forever, and Pi is
 * spawned per session, so the leak compounds. Five seconds is far longer than a
 * healthy server needs to exit and short enough that a wedged one is reaped.
 * Escalation is still graceful — SIGTERM first, SIGKILL only at the deadline.
 *
 * The other two are Ryu's own choice too, not values Claude documents; its
 * reference gives no default for either.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESTARTS = 3;

/**
 * How long a single `edit`/`write` tool result may wait for the server to push
 * fresh diagnostics before we give up and leave the result untouched.
 *
 * This bound is the whole reason the feature is safe to enable by default. The
 * handler sits between the tool finishing and the model seeing its output, so
 * every millisecond here is added latency on EVERY edit — including the common
 * case of a clean edit the server never re-publishes for. We keep it short and
 * we keep it absolute: a slow language server degrades to "no diagnostics this
 * time", never to a stalled turn.
 */
const DIAGNOSTICS_BUDGET_MS = 1200;

/** Bound on a model-invoked navigation request, so a wedged server can't hang a turn. */
const NAVIGATION_TIMEOUT_MS = 10_000;

/** Cap on diagnostics folded into a tool result, so a broken file can't blow up the context. */
const MAX_DIAGNOSTICS_LISTED = 20;

/** Cap on diagnostics returned by the `lsp_diagnostics` tool, which is explicitly asked for. */
const MAX_DIAGNOSTICS_REPORTED = 60;

/** Longest single diagnostic message we render; long type errors are otherwise unbounded. */
const MAX_MESSAGE_CHARS = 240;

/** How much of a server's stderr we retain to explain an abnormal exit. */
const STDERR_TAIL_CHARS = 1500;

/** Cap on hover text, which some servers answer with a whole doc comment. */
const MAX_HOVER_CHARS = 1200;

/** Cap on locations listed by lsp_definition / lsp_references. */
const MAX_LOCATIONS_LISTED = 50;

/** Cap on symbols listed by `lsp_symbols`, so a huge generated file can't flood context. */
const MAX_SYMBOLS_LISTED = 200;

/** Cap on matches returned by `lsp_symbol_search`. */
const MAX_SYMBOL_MATCHES = 50;

/** Cap on nodes in a rendered call hierarchy, which can explode on hot call sites. */
const MAX_CALL_HIERARCHY_NODES = 40;

/** Cap on the depth of a rendered call hierarchy. */
const MAX_CALL_HIERARCHY_DEPTH = 4;

/** Cap on a symbol's `detail` field, which some servers fill with a whole signature. */
const MAX_SYMBOL_DETAIL_CHARS = 100;

/** JSON-RPC "method not found", the correct reply to a server request we do not service. */
const JSONRPC_METHOD_NOT_FOUND = -32_601;

/** LSP DiagnosticSeverity -> label. Index is the wire value; 1 is the most severe. */
const SEVERITY_LABELS = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
} satisfies Record<Static<typeof severitySchema>, string>;

/** LSP SymbolKind -> label. Index is the wire value; the spec numbers start at 1. */
const SYMBOL_KIND_LABELS = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enumMember",
	23: "struct",
	24: "event",
	25: "operator",
	26: "typeParameter",
} satisfies Record<Static<typeof symbolKindSchema>, string>;

/** Every wire value 1..26, advertised as the client's supported SymbolKind set. */
const SYMBOL_KIND_VALUES = [
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
	23, 24, 25, 26,
];

/** Native JSON-RPC values are validated at config and framed stdio boundaries. */
type LspJsonValue =
	| null
	| boolean
	| number
	| string
	| LspJsonValue[]
	| LspJsonObject;
interface LspJsonObject {
	[key: string]: LspJsonValue;
}
const lspJsonValueSchema = Type.Cyclic(
	{
		Value: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Value")),
			Type.Record(Type.String(), Type.Ref("Value")),
		]),
	},
	"Value"
);
const lspJsonObjectSchema = Type.Record(Type.String(), lspJsonValueSchema);
const severitySchema = Type.Union([
	Type.Literal(1),
	Type.Literal(2),
	Type.Literal(3),
	Type.Literal(4),
]);
const symbolKindSchema = Type.Union([
	Type.Literal(1),
	Type.Literal(2),
	Type.Literal(3),
	Type.Literal(4),
	Type.Literal(5),
	Type.Literal(6),
	Type.Literal(7),
	Type.Literal(8),
	Type.Literal(9),
	Type.Literal(10),
	Type.Literal(11),
	Type.Literal(12),
	Type.Literal(13),
	Type.Literal(14),
	Type.Literal(15),
	Type.Literal(16),
	Type.Literal(17),
	Type.Literal(18),
	Type.Literal(19),
	Type.Literal(20),
	Type.Literal(21),
	Type.Literal(22),
	Type.Literal(23),
	Type.Literal(24),
	Type.Literal(25),
	Type.Literal(26),
]);
const lspStringSchema = Type.String();
const lspNumberSchema = Type.Number();
const lspBooleanSchema = Type.Boolean();
const lspPositiveNumberSchema = Type.Number({ exclusiveMinimum: 0 });
const lspPositionSchema = Type.Object({
	character: Type.Number(),
	line: Type.Number(),
});
const lspRangeSchema = Type.Object({
	end: lspPositionSchema,
	start: lspPositionSchema,
});
const lspJsonRpcSchema = Type.Object({
	error: Type.Optional(
		Type.Object({
			code: Type.Optional(Type.Number()),
			message: Type.Optional(Type.String()),
		})
	),
	id: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	method: Type.Optional(Type.String()),
	params: Type.Optional(lspJsonValueSchema),
	result: Type.Optional(lspJsonValueSchema),
});
const lspDiagnosticSchema = Type.Object({
	code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	message: Type.Optional(Type.String()),
	range: Type.Optional(lspRangeSchema),
	severity: Type.Optional(Type.Number()),
	source: Type.Optional(Type.String()),
});
const publishDiagnosticsSchema = Type.Object({ uri: Type.String() });
const changedPathSchema = Type.Object({ path: Type.String() });

/**
 * The `pi-copy` plugin's `copy_paste` tool. It writes `to_path` (default
 * `path`), so its destination gets the same post-write diagnostics as `edit`
 * and `write`; a cross-file move also rewrites `path`, which is diagnosed too.
 * Matched by name because it is a sibling extension's tool, not a Pi built-in
 * with an exported guard.
 */
const COPY_PASTE_TOOL = "copy_paste";
const copyPasteInputSchema = Type.Object({
	move: Type.Optional(Type.Boolean()),
	path: Type.String(),
	to_path: Type.Optional(Type.String()),
});

// ── Wire types ──────────────────────────────────────────────────────────────

interface JsonRpcMessage {
	error?: { code?: number; message?: string };
	id?: number | string;
	method?: string;
	params?: LspJsonValue;
	result?: LspJsonValue;
}

type LspPosition = Static<typeof lspPositionSchema>;
type LspRange = Static<typeof lspRangeSchema>;

interface LspLocation {
	range: LspRange;
	uri: string;
}

type LspDiagnostic = Static<typeof lspDiagnosticSchema>;

interface PublishDiagnosticsParams {
	diagnostics?: LspDiagnostic[];
	uri: string;
	version?: number;
}

/** One entry of `workspace/symbol`'s `WorkspaceSymbol` / `SymbolInformation` forms. */
interface WorkspaceSymbolLike {
	containerName?: string;
	kind?: number;
	location?: { range?: LspRange; uri?: string };
	name?: string;
}

/**
 * One `CallHierarchyItem`, the node type of both `prepareCallHierarchy` and the
 * call graph.
 *
 * `raw` is the VERBATIM record the server sent, held so a `callHierarchy/*`
 * request can echo it back untouched. This is load-bearing, not bookkeeping:
 * servers identify a symbol by opaque fields like clangd's `data`, which the
 * spec never names — strip them and the server answers the next hop with an
 * empty list. The LSP rule is "send back the same item you received".
 */
interface CallHierarchyItemLike {
	detail?: string;
	kind?: number;
	name?: string;
	range?: LspRange;
	raw: LspJsonObject;
	selectionRange?: LspRange;
	uri?: string;
}

// ── Config types ────────────────────────────────────────────────────────────

/**
 * A validated server declaration. Field names mirror Claude Code's `.lsp.json`
 * entry exactly; the only difference is that optional fields are resolved to
 * their defaults here so nothing downstream has to re-derive them.
 */
interface ServerConfig {
	args: string[];
	command: string;
	diagnostics: boolean;
	env: ServerEnvironment;
	/** Normalized ".ext" (lowercase, leading dot) -> LSP language id. */
	extensionToLanguage: Map<string, string>;
	id: string;
	initializationOptions?: LspJsonValue;
	maxRestarts: number;
	restartOnCrash: boolean;
	settings?: LspJsonValue;
	shutdownTimeout: number;
	startupTimeout: number;
	workspaceFolder?: string;
}

// ── Runtime state ───────────────────────────────────────────────────────────

/**
 * `skipped` is PERMANENT and is what keeps a missing binary from becoming
 * retry-spam: every later touch of a claimed file short-circuits on it without
 * a spawn attempt and without another log line.
 */
type ServerStatus = "idle" | "starting" | "ready" | "skipped";

interface OpenDocument {
	/** Fingerprint of the text the server was last sent — see `syncDocument`. */
	signature: string;
	uri: string;
	version: number;
}

/**
 * The last diagnostics publish for one file, WITH the document version the
 * server stamped on it.
 *
 * Retaining the version is load-bearing, not bookkeeping. A publish is the
 * server's verdict on one specific revision of the file, and real servers
 * (gopls and rust-analyzer both do this) finish analysing an older revision and
 * publish it after we have already sent a newer one. Storing bare diagnostics
 * would let that verdict on the PRE-edit text be read back as the verdict on
 * the edit — telling the model about errors its edit just fixed, which is worse
 * than reporting nothing. `undefined` means the server omitted the field, which
 * the spec allows; that degrades to the pre-3.15 "trust the latest publish"
 * behaviour rather than discarding everything such a server ever says.
 */
interface FileDiagnostics {
	diagnostics: LspDiagnostic[];
	version: number | undefined;
}

interface PendingRequest {
	reject: (reason: Error) => void;
	resolve: (value: LspJsonValue | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface DiagnosticsWaiter {
	finish: () => void;
	fsPath: string;
	/** Document version the waiter is waiting past; undefined accepts any publish. */
	version: number | undefined;
}

interface ServerRuntime {
	/** Unconsumed stdout bytes; frames are drained out of this, never off a string. */
	buffer: Buffer;
	child: ChildProcess | undefined;
	config: ServerConfig;
	diagnostics: Map<string, FileDiagnostics>;
	/** Keyed by RESOLVED FS PATH, never by URI — see `diagnosticsKey`. */
	documents: Map<string, OpenDocument>;
	nextRequestId: number;
	pending: Map<number, PendingRequest>;
	restarts: number;
	rootPath: string;
	serverCapabilities: LspJsonObject;
	/** Set by teardown so an expected exit is not mistaken for a crash. */
	shuttingDown: boolean;
	/** In-flight start, so N concurrent touches share ONE spawn. */
	starting: Promise<boolean> | undefined;
	status: ServerStatus;
	stderrTail: string;
	waiters: Set<DiagnosticsWaiter>;
}

/** Server id -> runtime. Rebuilt by the factory on every extension (re)bind. */
let servers = new Map<string, ServerRuntime>();

/** ".ext" -> owning server id, resolved once by first-registration-wins. */
let extensionOwners = new Map<string, string>();

// ── Small helpers ───────────────────────────────────────────────────────────

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: Error): string {
	return err.message;
}

/**
 * The reason channel. Core logs the ACP subprocess's stderr at WARN, so this
 * reaches an operator even when the managed Pi runs headless and every
 * `ctx.ui.*` call is a no-op.
 */
function log(message: string): void {
	try {
		process.stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		// A closed stderr must never break a turn.
	}
}

/**
 * Run `fn` against Pi's UI context, or do nothing at all.
 *
 * The `ctx?.hasUI` read is INSIDE the try on purpose: `hasUI` is a getter that
 * calls `assertActive()` and throws once this extension instance is invalidated
 * by a reload or session replacement, which any callback scheduled from a
 * detached LSP continuation can easily race. Swallowing here is the point — the
 * UI is decoration, and an exception escaping an extension callback is reported
 * as an extension error that can abort the surrounding turn.
 */
function withUi(
	ctx: ExtensionContext | undefined,
	fn: (ui: ExtensionContext["ui"]) => void
): void {
	try {
		if (!ctx?.hasUI) {
			return;
		}
		fn(ctx.ui);
	} catch {
		// Stale extension instance, or a mode that does not implement this method.
	}
}

function asRecord(value: LspJsonValue | undefined): LspJsonObject | undefined {
	return Check(lspJsonObjectSchema, value) ? value : undefined;
}

function parsedRange(value: LspJsonValue | undefined): LspRange | undefined {
	return Check(lspRangeSchema, value) ? value : undefined;
}

function asStringArray(value: LspJsonValue | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => Check(lspStringSchema, item));
}

interface ServerEnvironment {
	[variable: string]: string;
}
function asStringRecord(value: LspJsonValue | undefined): ServerEnvironment {
	const record = asRecord(value);
	const out: ServerEnvironment = {};
	if (!record) {
		return out;
	}
	for (const [key, item] of Object.entries(record)) {
		if (Check(lspStringSchema, item)) {
			out[key] = item;
		}
	}
	return out;
}

function asPositiveNumber(
	value: LspJsonValue | undefined,
	fallback: number
): number {
	return Check(lspPositiveNumberSchema, value) ? value : fallback;
}

function asBoolean(
	value: LspJsonValue | undefined,
	fallback: boolean
): boolean {
	return Check(lspBooleanSchema, value) ? value : fallback;
}

/**
 * Whether a ready server advertised a capability. Server capabilities hold
 * `true` or an options object for each supported feature, and nothing at all
 * for an unsupported one — so a plain Boolean coercion answers the question.
 * Gating a request on it turns "method not found" into a readable message and,
 * for workspace-wide queries, skips servers that would only error out.
 */
function serverSupports(runtime: ServerRuntime, capability: string): boolean {
	return Boolean(runtime.serverCapabilities[capability]);
}

/**
 * The key every per-file map in this file is keyed by: the resolved filesystem
 * path, NOT the URI string.
 *
 * This is not cosmetic. Servers echo back URIs that differ from the ones we
 * sent — percent-encoding of spaces and non-ASCII differs between
 * implementations, and on Windows the drive letter's case does too. Keying the
 * diagnostics map by the raw URI makes `publishDiagnostics` land under a key
 * the lookup never asks for, and the whole diagnostics feature then returns
 * nothing with no error anywhere. Round-tripping through `fileURLToPath` (and
 * building URIs with `pathToFileURL`, never a `file://${p}` template) removes
 * the whole class.
 */
function diagnosticsKey(uri: string): string | undefined {
	try {
		return path.resolve(fileURLToPath(uri));
	} catch {
		return;
	}
}

// ── Config discovery ────────────────────────────────────────────────────────

/**
 * Mirror of Core's `pi_config::config_dir()` resolution, minus the knob Core
 * keeps to itself: `RYU_PI_AGENT_DIR` is Core's override and is NOT present in
 * the Pi child's environment, while `PI_CODING_AGENT_DIR` is the already-
 * resolved value Core passes down. The `~/.ryu/pi-agent` fallback exists only
 * so a hand-run Pi still finds a config; when it is wrong (a dev profile puts
 * the dir elsewhere) it resolves to "file absent", which is already the no-op
 * path — which is why the missing-file branch below logs nothing.
 */
function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	return path.join(homedir(), ".ryu", "pi-agent");
}

function configPath(): string {
	return path.join(agentDir(), "extensions", "ryu-lsp.json");
}

/** Normalize `{ "go": "go", ".ts": "typescript" }` to `.ext` -> language id. */
function normalizeExtensionMap(raw: LspJsonObject): Map<string, string> {
	const out = new Map<string, string>();
	for (const [rawExt, rawLang] of Object.entries(raw)) {
		if (!(Check(lspStringSchema, rawLang) && rawLang.trim())) {
			continue;
		}
		const trimmed = rawExt.trim().toLowerCase();
		if (!trimmed || trimmed === ".") {
			continue;
		}
		out.set(trimmed.startsWith(".") ? trimmed : `.${trimmed}`, rawLang.trim());
	}
	return out;
}

/**
 * Validate one declaration. Returns the resolved config, or undefined after
 * logging why it was skipped.
 *
 * The "neither field present" case returns undefined SILENTLY and on purpose:
 * the file is Core-authored and may carry sibling metadata keys (a schema
 * version, a generation stamp) alongside the server map. Warning about those
 * would be pure noise. An entry with one required field but not the other is a
 * genuinely broken server declaration and does get the warning.
 */
function parseServerConfig(
	id: string,
	value: LspJsonValue | undefined
): ServerConfig | undefined {
	const entry = asRecord(value);
	if (!entry) {
		return;
	}
	const command = Check(lspStringSchema, entry.command)
		? entry.command.trim()
		: "";
	const languages = asRecord(entry.extensionToLanguage);
	if (!(command || languages)) {
		return;
	}
	if (!command) {
		log(`server "${id}" skipped: "command" is required.`);
		return;
	}
	if (!languages) {
		log(`server "${id}" skipped: "extensionToLanguage" is required.`);
		return;
	}
	const extensionToLanguage = normalizeExtensionMap(languages);
	if (extensionToLanguage.size === 0) {
		log(
			`server "${id}" skipped: "extensionToLanguage" maps no file extension.`
		);
		return;
	}
	// `transport` is an enumerated field in the model we are matching, so an
	// unsupported value is declined loudly rather than silently treated as
	// stdio — a socket server driven over its stdin would simply never answer.
	const transport = Check(lspStringSchema, entry.transport)
		? entry.transport.trim()
		: "stdio";
	if (transport !== "stdio") {
		log(
			`server "${id}" skipped: transport "${transport}" is not supported (stdio only).`
		);
		return;
	}
	return {
		id,
		command,
		args: asStringArray(entry.args),
		env: asStringRecord(entry.env),
		initializationOptions: entry.initializationOptions,
		settings: entry.settings,
		workspaceFolder:
			Check(lspStringSchema, entry.workspaceFolder) &&
			entry.workspaceFolder.trim()
				? entry.workspaceFolder.trim()
				: undefined,
		startupTimeout: asPositiveNumber(
			entry.startupTimeout,
			DEFAULT_STARTUP_TIMEOUT_MS
		),
		shutdownTimeout: asPositiveNumber(
			entry.shutdownTimeout,
			DEFAULT_SHUTDOWN_TIMEOUT_MS
		),
		restartOnCrash: asBoolean(entry.restartOnCrash, true),
		maxRestarts: asPositiveNumber(entry.maxRestarts, DEFAULT_MAX_RESTARTS),
		diagnostics: asBoolean(entry.diagnostics, true),
		extensionToLanguage,
	};
}

/**
 * Read and validate the resolved declaration. Never throws — every failure mode
 * (absent, unreadable, malformed, wrong shape) collapses to an empty list, and
 * an empty list is the complete no-op.
 *
 * Both shapes are accepted: a bare map of `id -> config` (Claude Code's
 * `.lsp.json`) and a `{ "servers": { ... } }` wrapper, because being liberal
 * here costs nothing and the wrapper is the obvious thing for a generator to
 * emit.
 */
async function loadServerConfigs(): Promise<ServerConfig[]> {
	const file = configPath();
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		// Absent config is the expected steady state when no LSP is declared.
		// Deliberately silent: logging here would warn on every single session.
		return [];
	}
	if (!raw.trim()) {
		return [];
	}
	let parsed: LspJsonValue;
	try {
		const decoded = JSON.parse(raw);
		if (!Check(lspJsonValueSchema, decoded)) {
			throw new Error("configuration contains a non-JSON value");
		}
		parsed = decoded;
	} catch (err) {
		log(
			`ignoring ${file}: not valid JSON (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
		);
		return [];
	}
	const root = asRecord(parsed);
	if (!root) {
		log(`ignoring ${file}: expected a JSON object of server declarations.`);
		return [];
	}
	const declarations = asRecord(root.servers) ?? root;
	const configs: ServerConfig[] = [];
	for (const [id, value] of Object.entries(declarations)) {
		const config = parseServerConfig(id, value);
		if (config) {
			configs.push(config);
		}
	}
	return configs;
}

/**
 * Resolve extension ownership by FIRST REGISTRATION WINS, deterministically
 * over the declaration order of the config object.
 *
 * A server whose every extension is already claimed is left in the registry but
 * will never be touched, and therefore never spawned — which is exactly the
 * documented behaviour ("the first registered handles it and the others never
 * start"). Servers skipped for invalid config never reach this function, so
 * they cannot claim an extension away from a valid one.
 */
function claimExtensions(configs: ServerConfig[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const config of configs) {
		for (const ext of config.extensionToLanguage.keys()) {
			const owner = owners.get(ext);
			if (owner) {
				log(
					`server "${config.id}" will not handle "${ext}" — already claimed by "${owner}" (first registration wins).`
				);
				continue;
			}
			owners.set(ext, config.id);
		}
	}
	return owners;
}

// ── Base protocol: framing ──────────────────────────────────────────────────

function writeMessage(
	runtime: ServerRuntime,
	payload: JsonRpcMessage & { jsonrpc: string }
): void {
	const stdin = runtime.child?.stdin;
	if (!stdin?.writable) {
		return;
	}
	try {
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		// One write, not two: Content-Length counts BYTES of the body, and a
		// header emitted separately from its body invites interleaving with a
		// concurrent write and an unrecoverable stream desync.
		stdin.write(
			Buffer.concat([
				Buffer.from(
					`Content-Length: ${body.length}${HEADER_TERMINATOR}`,
					"ascii"
				),
				body,
			])
		);
	} catch (err) {
		log(
			`server "${runtime.config.id}": write failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
		);
	}
}

/**
 * Drain every COMPLETE frame currently buffered.
 *
 * This is where naive implementations break, in both directions: a chunk may
 * carry only part of a frame (so we must keep the bytes and return), and it may
 * carry several frames at once (so we must loop until the buffer is short).
 * Everything is done on the Buffer rather than a decoded string because
 * Content-Length is a BYTE count and any multi-byte character in the body would
 * otherwise shift every subsequent frame boundary.
 */
function drainFrames(runtime: ServerRuntime): void {
	for (;;) {
		const headerEnd = runtime.buffer.indexOf(HEADER_TERMINATOR);
		if (headerEnd === -1) {
			return;
		}
		const bodyStart = headerEnd + HEADER_TERMINATOR.length;
		const header = runtime.buffer.subarray(0, headerEnd).toString("ascii");
		const length = Number(CONTENT_LENGTH_RE.exec(header)?.[1] ?? Number.NaN);
		if (!Number.isFinite(length) || length > MAX_FRAME_BYTES) {
			// Either a header block with no Content-Length, or one advertising a
			// body no real server would send. Both mean we lost sync with the
			// stream. Drop the block and resynchronise on the next one rather than
			// stalling forever on a frame that can never complete — for the
			// oversized case that stall would also buffer every later chunk behind
			// it, so treating it as garbage is what bounds our memory.
			if (Number.isFinite(length)) {
				log(
					`server "${runtime.config.id}": ignoring a frame advertising ${length} bytes (over the ${MAX_FRAME_BYTES}-byte cap); resynchronising.`
				);
			}
			runtime.buffer = runtime.buffer.subarray(bodyStart);
			continue;
		}
		const end = bodyStart + length;
		if (runtime.buffer.length < end) {
			// Partial body: keep everything and wait for the next chunk.
			return;
		}
		const body = runtime.buffer.subarray(bodyStart, end).toString("utf8");
		runtime.buffer = runtime.buffer.subarray(end);
		let message: JsonRpcMessage;
		try {
			const decoded = JSON.parse(body);
			if (!Check(lspJsonRpcSchema, decoded)) {
				continue;
			}
			message = decoded;
		} catch {
			continue;
		}
		dispatchMessage(runtime, message);
	}
}

// ── Base protocol: dispatch ─────────────────────────────────────────────────

function settleResponse(runtime: ServerRuntime, message: JsonRpcMessage): void {
	const id = Number(message.id);
	const pending = runtime.pending.get(id);
	if (!pending) {
		return;
	}
	runtime.pending.delete(id);
	clearTimeout(pending.timer);
	if (message.error) {
		pending.reject(
			new Error(message.error.message ?? `LSP error ${message.error.code}`)
		);
		return;
	}
	pending.resolve(message.result);
}

/**
 * Answer a server->client request.
 *
 * Answering is NOT optional. gopls, rust-analyzer and pyright all issue
 * `client/registerCapability` (and often `workspace/configuration`) during
 * startup and BLOCK on the reply; an unanswered request means the server never
 * reaches the point where it publishes diagnostics, i.e. the key feature of
 * this extension silently produces nothing. Anything we do not service gets a
 * proper `-32601` rather than silence, so a server can fall back instead of
 * waiting.
 */
function handleServerRequest(
	runtime: ServerRuntime,
	message: JsonRpcMessage
): void {
	const respond = (result: LspJsonValue | undefined): void => {
		writeMessage(runtime, { jsonrpc: "2.0", id: message.id, result });
	};
	switch (message.method) {
		case "client/registerCapability":
		case "client/unregisterCapability":
		case "window/workDoneProgress/create":
			respond(null);
			return;
		case "workspace/workspaceFolders":
			respond([
				{
					uri: pathToFileURL(runtime.rootPath).href,
					name: path.basename(runtime.rootPath),
				},
			]);
			return;
		case "workspace/configuration": {
			// We advertise `workspace.configuration: true`, so we owe one entry per
			// requested item. We hold exactly one settings blob for the whole server
			// (the config's `settings` field), so every item gets it; a server asking
			// for a section we do not model receives null and uses its own default.
			const items = asRecord(message.params)?.items;
			const count = Array.isArray(items) ? items.length : 1;
			respond(
				Array.from({ length: count }, () => runtime.config.settings ?? null)
			);
			return;
		}
		default:
			writeMessage(runtime, {
				jsonrpc: "2.0",
				id: message.id,
				error: {
					code: JSONRPC_METHOD_NOT_FOUND,
					message: `${message.method} is not supported by the Ryu LSP bridge`,
				},
			});
	}
}

function handlePublishDiagnostics(
	runtime: ServerRuntime,
	params: PublishDiagnosticsParams
): void {
	const key = diagnosticsKey(params.uri);
	if (!key) {
		return;
	}
	const diagnostics = Array.isArray(params.diagnostics)
		? params.diagnostics
		: [];
	const version = params.version;
	const previous = runtime.diagnostics.get(key);
	// Keep the stored verdict MONOTONIC in document version. A late publish for a
	// revision we have already moved past must not overwrite a fresher one, or
	// `lsp_diagnostics` would report errors from text that no longer exists. The
	// waiter loop below still runs either way: dropping the value must never be
	// the reason a bounded wait sits out its whole budget.
	const stale =
		version !== undefined &&
		previous?.version !== undefined &&
		version < previous.version;
	if (!stale) {
		runtime.diagnostics.set(key, { diagnostics, version });
	}
	for (const waiter of runtime.waiters) {
		if (waiter.fsPath !== key) {
			continue;
		}
		// `versionSupport` is advertised, so a compliant server stamps the version
		// of the document it analysed. Waiting for a publish at or past the version
		// we just sent is what stops a stale pre-edit publish from satisfying the
		// wait. A server that omits the field (the field is optional) falls back to
		// "any publish for this file", which is the pre-3.15 behaviour.
		if (
			waiter.version !== undefined &&
			params.version !== undefined &&
			params.version < waiter.version
		) {
			continue;
		}
		waiter.finish();
	}
}

/**
 * Read back the server's verdict on `fsPath`, but only if it is a verdict on the
 * revision we actually synced.
 *
 * `syncedVersion` is the version `syncDocument` left the document at. When the
 * server's latest publish is older than that, the server has not finished
 * analysing our edit yet — the bounded wait expired first — and the honest
 * answer is "nothing to report", not the diagnostics of the pre-edit text.
 * Passing `undefined` (the workspace-wide report, which is not tied to any one
 * sync) means "whatever is currently known".
 */
function currentDiagnostics(
	runtime: ServerRuntime,
	fsPath: string,
	syncedVersion: number | undefined
): LspDiagnostic[] {
	const entry = runtime.diagnostics.get(fsPath);
	if (!entry) {
		return [];
	}
	if (
		syncedVersion !== undefined &&
		entry.version !== undefined &&
		entry.version < syncedVersion
	) {
		return [];
	}
	return entry.diagnostics;
}

function dispatchMessage(
	runtime: ServerRuntime,
	message: JsonRpcMessage
): void {
	if (message.method && message.id !== undefined) {
		handleServerRequest(runtime, message);
		return;
	}
	if (message.method) {
		if (
			message.method === "textDocument/publishDiagnostics" &&
			Check(publishDiagnosticsSchema, message.params)
		) {
			const record = asRecord(message.params);
			const rawDiagnostics = record?.diagnostics;
			const version = record?.version;
			handlePublishDiagnostics(runtime, {
				uri: message.params.uri,
				diagnostics: Array.isArray(rawDiagnostics)
					? rawDiagnostics.filter((diagnostic) =>
							Check(lspDiagnosticSchema, diagnostic)
						)
					: [],
				version: Check(lspNumberSchema, version) ? version : undefined,
			});
		}
		// Every other notification (`window/logMessage`, `$/progress`,
		// `telemetry/event`, …) is intentionally dropped: none of it changes what
		// the model sees, and forwarding it would bury the reason channel.
		return;
	}
	if (message.id !== undefined) {
		settleResponse(runtime, message);
	}
}

function request(
	runtime: ServerRuntime,
	method: string,
	params: LspJsonValue | undefined,
	timeoutMs: number
): Promise<LspJsonValue | undefined> {
	const id = runtime.nextRequestId;
	runtime.nextRequestId += 1;
	return new Promise<LspJsonValue | undefined>((resolve, reject) => {
		const timer = setTimeout(() => {
			runtime.pending.delete(id);
			reject(new Error(`${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		// Never let a bounded wait be the reason Pi's event loop stays alive.
		timer.unref?.();
		runtime.pending.set(id, { resolve, reject, timer });
		writeMessage(runtime, { jsonrpc: "2.0", id, method, params });
	});
}

function notify(
	runtime: ServerRuntime,
	method: string,
	params: LspJsonValue | undefined
): void {
	writeMessage(runtime, { jsonrpc: "2.0", method, params });
}

// ── Server lifecycle ────────────────────────────────────────────────────────

function skipServer(runtime: ServerRuntime, reason: string): void {
	if (runtime.status === "skipped") {
		return;
	}
	runtime.status = "skipped";
	// Exactly one line per server, ever. The status is permanent, so this can
	// never become the retry-spam a missing binary would otherwise produce.
	log(`server "${runtime.config.id}" disabled: ${reason}`);
}

async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		const info = await stat(candidate);
		if (!info.isFile()) {
			return false;
		}
		if (process.platform !== "win32") {
			await access(candidate, fsConstants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe `command` the way a shell would, WITHOUT spawning it.
 *
 * Probing before spawning is what turns "you forgot to install gopls" into a
 * one-line reason instead of an opaque ENOENT from deep inside a child-process
 * error event. The declaration ships config only and never the binary, so this
 * is the expected path whenever a user has not installed the toolchain.
 */
async function resolveBinary(command: string): Promise<string | undefined> {
	if (command.includes("/") || command.includes("\\")) {
		const absolute = path.resolve(command);
		return (await isExecutableFile(absolute)) ? absolute : undefined;
	}
	const suffixes =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
					.split(";")
					.filter(Boolean)
			: [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) {
			continue;
		}
		for (const suffix of suffixes) {
			const candidate = path.join(dir, command + suffix);
			if (await isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}
	return;
}

/** Reject every in-flight request and release every waiter. */
function drainPendingWork(runtime: ServerRuntime, reason: string): void {
	for (const [, pending] of runtime.pending) {
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
	}
	runtime.pending.clear();
	for (const waiter of runtime.waiters) {
		// Release rather than hang: a diagnostics wait whose server just died must
		// fall through to "no diagnostics", not sit out its full budget.
		waiter.finish();
	}
	runtime.waiters.clear();
}

function handleServerExit(
	runtime: ServerRuntime,
	code: number | null,
	signal: NodeJS.Signals | null
): void {
	const detail = signal ? `signal ${signal}` : `exit code ${code}`;
	drainPendingWork(runtime, `language server exited (${detail})`);
	runtime.child = undefined;
	runtime.buffer = Buffer.alloc(0);
	runtime.documents.clear();
	// Diagnostics die with the server that published them. Keeping them would let
	// a stale pre-crash error be reported as current after a restart, for a file
	// the restarted server has not been asked to look at yet.
	runtime.diagnostics.clear();
	runtime.serverCapabilities = {};
	if (runtime.shuttingDown || runtime.status === "skipped") {
		return;
	}
	if (runtime.status === "starting") {
		// A death during the handshake is not a crash to recover from, it is a
		// misconfiguration. `startServer` is already awaiting an `initialize` that
		// `drainPendingWork` just rejected, and its catch turns this into a
		// permanent skip carrying the stderr tail. Restarting here would only race
		// that, and would emit a "will restart" line immediately contradicted by a
		// "disabled" line.
		return;
	}
	const tail = runtime.stderrTail.trim();
	if (!runtime.config.restartOnCrash) {
		skipServer(
			runtime,
			`crashed (${detail}) and restartOnCrash is false${tail ? ` — ${tail}` : ""}`
		);
		return;
	}
	runtime.restarts += 1;
	if (runtime.restarts > runtime.config.maxRestarts) {
		skipServer(
			runtime,
			`crashed ${runtime.restarts} times (${detail}), exceeding maxRestarts=${runtime.config.maxRestarts} — giving up${tail ? ` — ${tail}` : ""}`
		);
		return;
	}
	// Back to `idle`, not respawned here: restarting eagerly would resurrect a
	// server nobody is about to use. The next touched file spawns it, which also
	// re-opens the documents that actually matter.
	runtime.status = "idle";
	log(
		`server "${runtime.config.id}" crashed (${detail}); will restart on the next touched file (${runtime.restarts}/${runtime.config.maxRestarts}).`
	);
}

function attachChild(runtime: ServerRuntime, child: ChildProcess): void {
	runtime.child = child;
	// EVERY pipe needs an `error` listener, and this is not defensive padding.
	// When a language server dies, the writes already queued against its stdin
	// fail with EPIPE — and a stream reports that by EMITTING "error", not by
	// throwing where `writeMessage` could catch it. An "error" event with no
	// listener is an uncaught exception, so without these three lines a server
	// that crashes at the wrong moment takes the whole Pi agent process down with
	// it. There is nothing to do about the failed write itself: the `exit`
	// handler is already on its way and it owns the reporting and the restart.
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		stream?.on("error", () => {
			// Intentionally silent — see above.
		});
	}
	child.stdout?.on("data", (chunk: Buffer) => {
		runtime.buffer =
			runtime.buffer.length === 0
				? chunk
				: Buffer.concat([runtime.buffer, chunk]);
		try {
			drainFrames(runtime);
		} catch (err) {
			// A stdout handler throws on Pi's own event loop; swallowing keeps a
			// malformed frame from taking the whole agent process down.
			log(
				`server "${runtime.config.id}": dispatch failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
			);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		// Retained, not forwarded: language servers are extremely chatty on stderr
		// and Core logs this process's stderr verbatim. We keep only enough to
		// explain an abnormal exit.
		runtime.stderrTail = (runtime.stderrTail + chunk.toString("utf8")).slice(
			-STDERR_TAIL_CHARS
		);
	});
	child.on("error", (err: Error) => {
		skipServer(runtime, `failed to start: ${err.message}`);
		drainPendingWork(runtime, err.message);
	});
	child.on("exit", (code, signal) => {
		handleServerExit(runtime, code, signal);
	});
}

/**
 * The client capabilities we advertise.
 *
 * Deliberately narrow, and deliberately honest: we advertise
 * `workspace.configuration` and `workspace.workspaceFolders` ONLY because
 * `handleServerRequest` actually answers both. Advertising a capability whose
 * request we would leave unanswered is worse than not advertising it, because
 * the server blocks on us instead of falling back to its own defaults.
 */
function clientCapabilities() {
	return {
		general: { positionEncodings: ["utf-16"] },
		workspace: {
			workspaceFolders: true,
			configuration: true,
			didChangeConfiguration: { dynamicRegistration: false },
			symbol: {
				dynamicRegistration: false,
				hierarchicalWorkspaceSymbolSupport: true,
				symbolKind: { valueSet: SYMBOL_KIND_VALUES },
			},
		},
		textDocument: {
			synchronization: {
				dynamicRegistration: false,
				willSave: false,
				willSaveWaitUntil: false,
				didSave: true,
			},
			publishDiagnostics: {
				relatedInformation: false,
				// Load-bearing for the bounded wait: with version support the server
				// stamps each publish with the document version it analysed, which is
				// how we tell a fresh post-edit publish from a stale pre-edit one.
				versionSupport: true,
				tagSupport: { valueSet: [1, 2] },
			},
			definition: { dynamicRegistration: false, linkSupport: true },
			references: { dynamicRegistration: false },
			hover: {
				dynamicRegistration: false,
				contentFormat: ["markdown", "plaintext"],
			},
			implementation: { dynamicRegistration: false, linkSupport: true },
			documentSymbol: {
				dynamicRegistration: false,
				hierarchicalDocumentSymbolSupport: true,
				symbolKind: { valueSet: SYMBOL_KIND_VALUES },
			},
			callHierarchy: { dynamicRegistration: false },
		},
	};
}

async function startServer(
	runtime: ServerRuntime,
	cwd: string
): Promise<boolean> {
	const { config } = runtime;
	runtime.status = "starting";
	runtime.stderrTail = "";
	// `workspaceFolder` is resolved against the session cwd, so a declaration can
	// pin a server to a sub-project without knowing the absolute path.
	runtime.rootPath = config.workspaceFolder
		? path.resolve(cwd, config.workspaceFolder)
		: cwd;

	const binary = await resolveBinary(config.command);
	if (!binary) {
		const extensions = [...config.extensionToLanguage.keys()].join(", ");
		skipServer(
			runtime,
			`"${config.command}" is not on PATH; install it to enable language support for ${extensions}`
		);
		return false;
	}

	try {
		// A `.cmd`/`.bat` shim (how most npm-installed servers land on Windows)
		// cannot be exec'd directly by Node and needs the cmd.exe hop.
		const needsShell =
			process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
		attachChild(
			runtime,
			spawn(binary, config.args, {
				cwd: runtime.rootPath,
				env: { ...process.env, ...config.env },
				stdio: ["pipe", "pipe", "pipe"],
				shell: needsShell,
				windowsHide: true,
			})
		);
	} catch (err) {
		skipServer(
			runtime,
			`failed to spawn: ${errorText(err instanceof Error ? err : new Error(String(err)))}`
		);
		return false;
	}

	try {
		const params = {
			processId: process.pid,
			clientInfo: { name: "ryu-lsp", version: "1" },
			rootUri: pathToFileURL(runtime.rootPath).href,
			rootPath: runtime.rootPath,
			workspaceFolders: [
				{
					uri: pathToFileURL(runtime.rootPath).href,
					name: path.basename(runtime.rootPath),
				},
			],
			capabilities: clientCapabilities(),
		};
		if (config.initializationOptions !== undefined) {
			Object.assign(params, {
				initializationOptions: config.initializationOptions,
			});
		}
		const result = await request(
			runtime,
			"initialize",
			params,
			config.startupTimeout
		);
		runtime.serverCapabilities = asRecord(asRecord(result)?.capabilities) ?? {};
	} catch (err) {
		// A startup timeout is a PERMANENT skip, unlike a crash. `restartOnCrash`
		// governs a server that started and then died; one that cannot complete a
		// handshake inside its own declared `startupTimeout` is misconfigured, and
		// retrying it would re-pay the full timeout on every touched file.
		runtime.child?.kill("SIGKILL");
		// The stderr tail is the only place a server explains itself when it dies
		// before answering `initialize` ("gopls: no module in view", a missing
		// runtime, a bad flag), so it rides along with the reason.
		const tail = runtime.stderrTail.trim();
		skipServer(
			runtime,
			`initialize failed: ${errorText(err instanceof Error ? err : new Error(String(err)))}${tail ? ` — ${tail}` : ""}`
		);
		return false;
	}

	notify(runtime, "initialized", {});
	if (config.settings !== undefined) {
		notify(runtime, "workspace/didChangeConfiguration", {
			settings: config.settings,
		});
	}
	runtime.status = "ready";
	log(`server "${config.id}" ready (${binary}) for ${runtime.rootPath}`);
	return true;
}

/**
 * Bring `runtime` up if it is not already, and report whether it is usable.
 *
 * The in-flight promise is shared so N files touched in the same batch produce
 * ONE spawn rather than N races, and the terminal `skipped` status is checked
 * first so a disabled server costs a map lookup.
 */
function ensureServer(runtime: ServerRuntime, cwd: string): Promise<boolean> {
	if (runtime.status === "ready") {
		return Promise.resolve(true);
	}
	if (runtime.status === "skipped") {
		return Promise.resolve(false);
	}
	if (!runtime.starting) {
		runtime.starting = startServer(runtime, cwd)
			.catch((err) => {
				skipServer(
					runtime,
					`failed to start: ${errorText(err instanceof Error ? err : new Error(String(err)))}`
				);
				return false;
			})
			.finally(() => {
				runtime.starting = undefined;
			});
	}
	return runtime.starting;
}

/**
 * Stop one server and reset its runtime to a clean `idle`.
 *
 * Idempotent by construction, which matters twice over: `session_shutdown` may
 * be delivered more than once, and resetting (rather than deleting) the runtime
 * means a jiti-cached module that comes back across a reload never holds a dead
 * `ChildProcess` handle.
 */
async function stopServer(runtime: ServerRuntime): Promise<void> {
	const child = runtime.child;
	runtime.shuttingDown = true;
	if (!child) {
		runtime.shuttingDown = false;
		runtime.status = runtime.status === "skipped" ? "skipped" : "idle";
		return;
	}
	// Closing the documents we opened is part of a well-behaved teardown; a
	// server that persists per-document state would otherwise keep it forever.
	for (const [, doc] of runtime.documents) {
		notify(runtime, "textDocument/didClose", {
			textDocument: { uri: doc.uri },
		});
	}
	try {
		await request(runtime, "shutdown", null, runtime.config.shutdownTimeout);
		notify(runtime, "exit", undefined);
	} catch {
		// A server that will not answer `shutdown` gets no more courtesy.
	}
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			// SIGKILL is the backstop the `shutdownTimeout` field exists to bound:
			// a wedged server must never keep the Pi process alive, because pi-acp
			// spawns a fresh Pi per chat turn and the leak would compound per turn.
			child.kill("SIGKILL");
			resolve();
		}, runtime.config.shutdownTimeout);
		timer.unref?.();
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGTERM");
	});
	drainPendingWork(runtime, "language server stopped");
	runtime.child = undefined;
	runtime.buffer = Buffer.alloc(0);
	runtime.documents.clear();
	runtime.diagnostics.clear();
	runtime.serverCapabilities = {};
	runtime.shuttingDown = false;
	runtime.status = runtime.status === "skipped" ? "skipped" : "idle";
}

async function stopAllServers(
	registry: Map<string, ServerRuntime>
): Promise<void> {
	await Promise.all(
		[...registry.values()].map((runtime) =>
			stopServer(runtime).catch((err) => {
				log(
					`server "${runtime.config.id}": shutdown failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
				);
			})
		)
	);
}

// ── Document synchronisation ────────────────────────────────────────────────

/**
 * Outcome of a sync. `changed: false` means the server already holds exactly
 * this text, so no publish is coming and nobody should wait for one.
 */
interface SyncResult {
	changed: boolean;
	version: number;
}

/**
 * Cheap non-cryptographic fingerprint (FNV-1a over UTF-16 code units, salted
 * with the length) of a document's text.
 *
 * Used only to suppress a redundant `didChange`. A collision costs one skipped
 * refresh, never a wrong answer to the model, and the honest alternative —
 * retaining every synced file's full text for the life of the session — is a
 * real memory cost for a session that touches a large tree.
 */
function fingerprint(text: string): string {
	let hash = 0x81_1c_9d_c5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Whether the server asked to be told about saves, and whether it wants the
 * text with them. The numeric `textDocumentSync` form carries no save
 * information at all, so it is treated as "does not want saves".
 */
interface DocumentSaveOptions {
	send: boolean;
	text: boolean;
}
function saveOptions(runtime: ServerRuntime): DocumentSaveOptions {
	const sync = runtime.serverCapabilities.textDocumentSync;
	const record = asRecord(sync);
	if (!record) {
		return { send: false, text: false };
	}
	const save = record.save;
	if (save === true) {
		return { send: true, text: false };
	}
	const saveRecord = asRecord(save);
	if (!saveRecord) {
		return { send: false, text: false };
	}
	return { send: true, text: saveRecord.includeText === true };
}

/**
 * Open or refresh `fsPath` on `runtime`, and return the document version the
 * server was left at (used to match the diagnostics publish that follows).
 *
 * FULL SYNC, ALWAYS — the simplest CORRECT choice here. Incremental sync would
 * require LSP ranges for each change, and the only thing this extension is
 * handed is the edit tool's textual diff, from which ranges cannot be
 * reconstructed reliably (and a single wrong range silently corrupts the
 * server's mirror of the file for the rest of the session). Re-reading the file
 * off disk and sending the whole text is exactly the state the server would
 * have read itself. The single-element `{ text }` change is the spec's
 * full-replacement form; servers that advertise incremental sync accept it too,
 * and it is the only form we can produce honestly.
 */
async function syncDocument(
	runtime: ServerRuntime,
	fsPath: string,
	languageId: string,
	didSave: boolean
): Promise<SyncResult | undefined> {
	// Pin the child we are syncing AGAINST, so the continuation below can tell
	// whether it is still talking to the same process. See the re-check.
	const child = runtime.child;
	if (!child) {
		return;
	}
	let text: string;
	try {
		text = await readFile(fsPath, "utf8");
	} catch {
		// The file was deleted or is binary. Nothing to say about it.
		return;
	}
	if (runtime.child !== child) {
		// The server died (or was shut down) while we were reading the file, and
		// `handleServerExit` has already cleared `documents`. Falling through would
		// re-add an entry for a document that NO live server was ever sent: the
		// `didOpen` below is dropped by `writeMessage` because there is no stdin to
		// write to, but the map would still claim the file is open. The restarted
		// server would then never receive it — and because the entry's signature
		// still matches the file, every later touch short-circuits on
		// `changed: false` and reads an empty diagnostics map. That file would be
		// silently dead for the rest of the session. Mutating nothing leaves the
		// next touch to open it cleanly on the new process.
		return;
	}
	const uri = pathToFileURL(fsPath).href;
	const signature = fingerprint(text);
	const open = runtime.documents.get(fsPath);
	if (open?.signature === signature) {
		// Byte-identical to what the server already holds. Re-notifying would make
		// it re-analyse the whole package for nothing, and — worse — would leave a
		// caller waiting out its whole diagnostics budget for a publish the server
		// has no reason to emit. Callers read the cached diagnostics instead.
		return { version: open.version, changed: false };
	}
	let version: number;
	if (open) {
		version = open.version + 1;
		open.version = version;
		open.signature = signature;
		notify(runtime, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	} else {
		version = 1;
		runtime.documents.set(fsPath, { uri, version, signature });
		notify(runtime, "textDocument/didOpen", {
			textDocument: { uri, languageId, version, text },
		});
	}
	if (didSave) {
		const save = saveOptions(runtime);
		if (save.send) {
			const params: LspJsonObject = { textDocument: { uri } };
			if (save.text) {
				params.text = text;
			}
			notify(runtime, "textDocument/didSave", params);
		}
	}
	return { version, changed: true };
}

/**
 * Wait, briefly and unconditionally boundedly, for a diagnostics publish for
 * `fsPath` at or past `version`.
 *
 * Resolves on the publish, on the budget expiring, or on the turn being
 * aborted — never rejects, and never outlives its budget. The abort hookup is
 * what makes Esc actually interrupt an edit that is waiting on a slow server.
 */
function waitForDiagnostics(
	runtime: ServerRuntime,
	fsPath: string,
	version: number | undefined,
	signal: AbortSignal | undefined
): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			runtime.waiters.delete(waiter);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const waiter: DiagnosticsWaiter = { fsPath, version, finish };
		runtime.waiters.add(waiter);
		timer = setTimeout(finish, DIAGNOSTICS_BUDGET_MS);
		timer.unref?.();
		if (signal?.aborted) {
			finish();
			return;
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}

// ── Rendering ───────────────────────────────────────────────────────────────

function displayPath(cwd: string, fsPath: string): string {
	const relative = path.relative(cwd, fsPath);
	return relative && !relative.startsWith("..") ? relative : fsPath;
}

function severityRank(diagnostic: LspDiagnostic): number {
	return diagnostic.severity ?? 1;
}

function formatDiagnostic(
	cwd: string,
	fsPath: string,
	diagnostic: LspDiagnostic
): string {
	const line = (diagnostic.range?.start?.line ?? 0) + 1;
	const column = (diagnostic.range?.start?.character ?? 0) + 1;
	const rank = severityRank(diagnostic);
	const severity = Check(severitySchema, rank)
		? SEVERITY_LABELS[rank]
		: "error";
	// `message` is required by the spec and typed as such, but it arrives off the
	// wire from a third-party process. A server that omits it must cost us one
	// blank diagnostic line, not a TypeError thrown out of a tool's `execute`.
	const message = (diagnostic.message ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_MESSAGE_CHARS);
	const parts = [diagnostic.source, diagnostic.code].filter(
		(part) => part !== undefined && part !== ""
	);
	const tag = parts.length ? ` [${parts.join("/")}]` : "";
	return `${displayPath(cwd, fsPath)}:${line}:${column}: ${severity}: ${message}${tag}`;
}

/**
 * Render diagnostics compactly, most severe first, with a hard cap.
 *
 * The cap is not cosmetic: a single syntax error in a large file can make a
 * server emit hundreds of cascading diagnostics, and an uncapped block would
 * blow up the model's context on exactly the turn where it most needs the room
 * to fix the error.
 */
function formatDiagnosticsBlock(
	cwd: string,
	entries: Array<{ fsPath: string; diagnostics: LspDiagnostic[] }>,
	cap: number
): string {
	const flat: Array<{ fsPath: string; diagnostic: LspDiagnostic }> = [];
	for (const entry of entries) {
		for (const diagnostic of entry.diagnostics) {
			flat.push({ fsPath: entry.fsPath, diagnostic });
		}
	}
	flat.sort((a, b) => {
		const bySeverity = severityRank(a.diagnostic) - severityRank(b.diagnostic);
		if (bySeverity !== 0) {
			return bySeverity;
		}
		return (
			(a.diagnostic.range?.start?.line ?? 0) -
			(b.diagnostic.range?.start?.line ?? 0)
		);
	});
	const lines = flat
		.slice(0, cap)
		.map((item) => `  ${formatDiagnostic(cwd, item.fsPath, item.diagnostic)}`);
	if (flat.length > cap) {
		lines.push(`  …and ${flat.length - cap} more`);
	}
	return lines.join("\n");
}

// ── Tool-result diagnostics ─────────────────────────────────────────────────

interface ResolvedTarget {
	fsPath: string;
	languageId: string;
	runtime: ServerRuntime;
}

/**
 * Route a file to the server that OWNS its extension, per first-registration-
 * wins. Returns undefined when nothing claims the extension — the overwhelming
 * majority of files in any repo — which is the cheap path this whole feature
 * has to stay cheap on.
 */
function targetFor(fsPath: string): ResolvedTarget | undefined {
	const ext = path.extname(fsPath).toLowerCase();
	if (!ext) {
		return;
	}
	const ownerId = extensionOwners.get(ext);
	if (!ownerId) {
		return;
	}
	const runtime = servers.get(ownerId);
	const languageId = runtime?.config.extensionToLanguage.get(ext);
	if (!(runtime && languageId)) {
		return;
	}
	return { runtime, fsPath, languageId };
}

/**
 * The changed path is read off `event.input.path`, not off `details`.
 *
 * `EditToolDetails` carries only `{ diff, patch, firstChangedLine }` and the
 * write tool's details are typed `undefined` outright, so `input` is the only
 * source. Both tool schemas document the path as "relative or absolute" and
 * resolve it internally against the session cwd, so we must do the same before
 * building a URI from it.
 */
function changedPath(
	input: Static<typeof changedPathSchema>,
	cwd: string
): string | undefined {
	const raw = input.path;
	if (!raw.trim()) {
		return;
	}
	return path.resolve(cwd, raw.trim());
}

async function diagnosticsForChangedFile(
	input: Static<typeof changedPathSchema>,
	ctx: ExtensionContext
): Promise<string | undefined> {
	const fsPath = changedPath(input, ctx.cwd);
	if (!fsPath) {
		return;
	}
	const target = targetFor(fsPath);
	// `diagnostics: false` opts a server out of pushing into the model's context
	// while leaving its navigation tools fully usable.
	if (!target?.runtime.config.diagnostics) {
		return;
	}
	if (target.runtime.status !== "ready") {
		// WARM THE SERVER, BUT DO NOT AWAIT IT. Pi awaits this handler before the
		// model sees the tool result, and a cold start is the slow part by orders
		// of magnitude: `startupTimeout` defaults to 15s, and gopls or
		// rust-analyzer routinely take seconds to answer `initialize` on a real
		// repo while they index it. Awaiting here would stall the agent's turn on
		// the FIRST edit to every language — exactly the thing `DIAGNOSTICS_BUDGET_MS`
		// bounds everywhere else. The touch still triggers the lazy spawn, which is
		// all the lazy-start contract asks for; this one edit reports nothing, and
		// every edit after the handshake completes reports normally.
		ensureServer(target.runtime, ctx.cwd).catch(() => {
			// `ensureServer` already converts its own failures into a permanent
			// skip with a logged reason; there is nothing to add here.
		});
		return;
	}
	const sync = await syncDocument(
		target.runtime,
		fsPath,
		target.languageId,
		true
	);
	if (!sync) {
		return;
	}
	if (sync.changed) {
		await waitForDiagnostics(target.runtime, fsPath, sync.version, ctx.signal);
	}
	const diagnostics = currentDiagnostics(target.runtime, fsPath, sync.version);
	// An empty publish means the file is clean. We append nothing rather than a
	// "no problems" line: that line would ride along on every single edit for
	// zero information, and the absence of a diagnostics block already says it.
	if (diagnostics.length === 0) {
		return;
	}
	return `Language server diagnostics (${target.runtime.config.id}):\n${formatDiagnosticsBlock(
		ctx.cwd,
		[{ fsPath, diagnostics }],
		MAX_DIAGNOSTICS_LISTED
	)}`;
}

// ── Navigation tools ────────────────────────────────────────────────────────

/**
 * Convert the 1-based line/column the tools take into an LSP `Position`.
 *
 * The tools speak 1-based because that is what the model reads in compiler
 * output, in `grep` results and in this extension's own diagnostics block. LSP
 * is 0-based, and its `character` is a UTF-16 code-unit offset (we advertise
 * `positionEncodings: ["utf-16"]`, the protocol default), which is also what
 * JavaScript string indices are — so the conversion is a plain subtraction.
 */
function toPosition(
	line: number | undefined,
	column: number | undefined
): LspPosition {
	const lineNumber = line !== undefined && line > 0 ? line : 1;
	const columnNumber = column !== undefined && column > 0 ? column : 1;
	return { line: lineNumber - 1, character: columnNumber - 1 };
}

/**
 * A navigation request that is ready to send. Unlike the `tool_result` path,
 * this one DOES await a cold start: the model explicitly asked for language-
 * server data, so paying the handshake once is the answer to its question
 * rather than latency imposed on work it did not ask for.
 */
interface PreparedRequest {
	sync: SyncResult | undefined;
	target: ResolvedTarget;
	uri: string;
}

async function prepareRequest(
	rawPath: string | undefined,
	ctx: ExtensionContext
): Promise<PreparedRequest | { message: string }> {
	if (!rawPath?.trim()) {
		throw new Error("`path` is required.");
	}
	const fsPath = path.resolve(ctx.cwd, rawPath.trim());
	const target = targetFor(fsPath);
	if (!target) {
		const covered = [...extensionOwners.keys()].join(", ") || "none";
		return {
			message: `No language server is configured for ${path.extname(fsPath) || "this file type"} (configured: ${covered}).`,
		};
	}
	if (!(await ensureServer(target.runtime, ctx.cwd))) {
		return {
			message: `The "${target.runtime.config.id}" language server is unavailable; see the Ryu logs for the reason.`,
		};
	}
	const sync = await syncDocument(
		target.runtime,
		fsPath,
		target.languageId,
		false
	);
	return { target, uri: pathToFileURL(fsPath).href, sync };
}

/** Normalize `Location | Location[] | LocationLink[] | null` to plain locations. */
function toLocations(result: LspJsonValue | undefined): LspLocation[] {
	const items = Array.isArray(result) ? result : [result];
	const out: LspLocation[] = [];
	for (const item of items) {
		const record = asRecord(item);
		if (!record) {
			continue;
		}
		const uri = Check(lspStringSchema, record.uri)
			? record.uri
			: Check(lspStringSchema, record.targetUri)
				? record.targetUri
				: undefined;
		const range =
			parsedRange(record.range) ??
			parsedRange(record.targetSelectionRange) ??
			parsedRange(record.targetRange);
		if (uri && range) {
			out.push({ uri, range });
		}
	}
	return out;
}

function renderLocations(cwd: string, locations: LspLocation[]): string {
	if (locations.length === 0) {
		return "No results.";
	}
	const lines = locations.slice(0, MAX_LOCATIONS_LISTED).map((location) => {
		const fsPath = diagnosticsKey(location.uri) ?? location.uri;
		const line = (location.range?.start?.line ?? 0) + 1;
		const column = (location.range?.start?.character ?? 0) + 1;
		return `${displayPath(cwd, fsPath)}:${line}:${column}`;
	});
	if (locations.length > MAX_LOCATIONS_LISTED) {
		lines.push(`…and ${locations.length - MAX_LOCATIONS_LISTED} more`);
	}
	return lines.join("\n");
}

/** Flatten `MarkupContent | MarkedString | MarkedString[]` into plain text. */
function renderHoverContents(contents: LspJsonValue | undefined): string {
	if (Check(lspStringSchema, contents)) {
		return contents;
	}
	if (Array.isArray(contents)) {
		return contents.map((item) => renderHoverContents(item)).join("\n\n");
	}
	const record = asRecord(contents);
	if (record && Check(lspStringSchema, record.value)) {
		return record.value;
	}
	return "";
}

// ── Symbol & call-hierarchy rendering ───────────────────────────────────────

/** Wire SymbolKind -> short label, with a safe fallback for a value the spec does not name. */
function symbolKindLabel(kind: LspJsonValue | undefined): string {
	return Check(symbolKindSchema, kind) ? SYMBOL_KIND_LABELS[kind] : "symbol";
}

/**
 * Render one `DocumentSymbol`, nested by its `children`, into `lines`.
 *
 * The outline uses `selectionRange` for the position (the range of the name,
 * not the whole symbol including its body), so the reader lands where the
 * symbol starts reading. `detail` is where servers put the signature, and is
 * capped so a whole generic signature cannot blow up the outline.
 */
function pushDocumentSymbol(
	cwd: string,
	fsPath: string,
	item: LspJsonValue | undefined,
	depth: number,
	lines: string[]
): void {
	if (lines.length >= MAX_SYMBOLS_LISTED) {
		return;
	}
	const record = asRecord(item);
	if (!record) {
		return;
	}
	const range = parsedRange(record.selectionRange) ?? parsedRange(record.range);
	const line = (range?.start?.line ?? 0) + 1;
	const column = (range?.start?.character ?? 0) + 1;
	const name = Check(lspStringSchema, record.name) ? record.name : "?";
	const detail =
		Check(lspStringSchema, record.detail) && record.detail.trim()
			? ` — ${record.detail.trim().slice(0, MAX_SYMBOL_DETAIL_CHARS)}`
			: "";
	const indent = "  ".repeat(depth);
	lines.push(
		`${indent}${displayPath(cwd, fsPath)}:${line}:${column} [${symbolKindLabel(record.kind)}] ${name}${detail}`
	);
	if (Array.isArray(record.children)) {
		for (const child of record.children) {
			pushDocumentSymbol(cwd, fsPath, child, depth + 1, lines);
		}
	}
}

/**
 * Render the answer to `textDocument/documentSymbol`, which is either the
 * hierarchical `DocumentSymbol[]` form or the flat `SymbolInformation[]` form.
 * The two are told apart by `selectionRange`: only `DocumentSymbol` has one.
 */
function renderDocumentSymbols(
	cwd: string,
	fsPath: string,
	raw: LspJsonValue | undefined
): string {
	if (!Array.isArray(raw) || raw.length === 0) {
		return "No symbols in this file.";
	}
	const hierarchical = asRecord(raw[0])?.selectionRange !== undefined;
	const lines: string[] = [];
	if (hierarchical) {
		for (const item of raw) {
			pushDocumentSymbol(cwd, fsPath, item, 0, lines);
		}
	} else {
		for (const item of raw) {
			const record = asRecord(item);
			if (!record) {
				continue;
			}
			const range = parsedRange(asRecord(record.location)?.range);
			const line = (range?.start?.line ?? 0) + 1;
			const column = (range?.start?.character ?? 0) + 1;
			const name = Check(lspStringSchema, record.name) ? record.name : "?";
			const container =
				Check(lspStringSchema, record.containerName) && record.containerName
					? `${record.containerName}.`
					: "";
			lines.push(
				`${displayPath(cwd, fsPath)}:${line}:${column} [${symbolKindLabel(record.kind)}] ${container}${name}`
			);
			if (lines.length >= MAX_SYMBOLS_LISTED) {
				break;
			}
		}
	}
	if (lines.length >= MAX_SYMBOLS_LISTED) {
		lines.push(`…and more symbols (capped at ${MAX_SYMBOLS_LISTED})`);
	}
	return lines.join("\n");
}

/**
 * Normalize the answer to `workspace/symbol`, which is `WorkspaceSymbol[]` or
 * `SymbolInformation[]`. A 3.17 `WorkspaceSymbol` may carry a bare `{ uri }`
 * as its `location` when the server expects a follow-up resolve we do not do,
 * so `range` is optional and renders as line 1.
 */
function toWorkspaceSymbols(
	raw: LspJsonValue | undefined
): WorkspaceSymbolLike[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: WorkspaceSymbolLike[] = [];
	for (const item of raw) {
		const record = asRecord(item);
		if (!(record && Check(lspStringSchema, record.name))) {
			continue;
		}
		const location = asRecord(record.location);
		out.push({
			name: record.name,
			kind: Check(lspNumberSchema, record.kind) ? record.kind : undefined,
			containerName: Check(lspStringSchema, record.containerName)
				? record.containerName
				: undefined,
			location: {
				uri: Check(lspStringSchema, location?.uri) ? location.uri : undefined,
				range: parsedRange(location?.range),
			},
		});
	}
	return out;
}

function renderWorkspaceSymbols(
	cwd: string,
	perServer: Array<{ serverId: string; symbols: WorkspaceSymbolLike[] }>
): string {
	const flat = perServer.flatMap((entry) =>
		entry.symbols.map((symbol) => ({ serverId: entry.serverId, symbol }))
	);
	if (flat.length === 0) {
		return "No matching symbols.";
	}
	// The server id only earns its place on the line when the query spanned
	// more than one server; a single-server search would be pure noise.
	const multiple = perServer.length > 1;
	const lines = flat
		.slice(0, MAX_SYMBOL_MATCHES)
		.map(({ serverId, symbol }) => {
			const uri = symbol.location?.uri;
			const fsPath = uri ? (diagnosticsKey(uri) ?? uri) : "";
			const line = (symbol.location?.range?.start?.line ?? 0) + 1;
			const column = (symbol.location?.range?.start?.character ?? 0) + 1;
			const container = symbol.containerName ? `${symbol.containerName}.` : "";
			const location = fsPath
				? `${displayPath(cwd, fsPath)}:${line}:${column}`
				: "workspace";
			const owner = multiple ? `(${serverId}) ` : "";
			return `${owner}${location} [${symbolKindLabel(symbol.kind)}] ${container}${symbol.name}`;
		});
	if (flat.length > MAX_SYMBOL_MATCHES) {
		lines.push(`…and ${flat.length - MAX_SYMBOL_MATCHES} more`);
	}
	return lines.join("\n");
}

function toCallHierarchyItem(
	raw: LspJsonValue | undefined
): CallHierarchyItemLike | undefined {
	const record = asRecord(raw);
	if (!record) {
		return;
	}
	return {
		name: Check(lspStringSchema, record.name) ? record.name : "?",
		kind: Check(lspNumberSchema, record.kind) ? record.kind : undefined,
		uri: Check(lspStringSchema, record.uri) ? record.uri : undefined,
		detail: Check(lspStringSchema, record.detail) ? record.detail : undefined,
		selectionRange: parsedRange(record.selectionRange),
		range: parsedRange(record.range),
		raw: record,
	};
}

/** `prepareCallHierarchy` answers one item or an array of them. */
function toCallHierarchyItems(
	raw: LspJsonValue | undefined
): CallHierarchyItemLike[] {
	const records = Array.isArray(raw) ? raw : [raw];
	const out: CallHierarchyItemLike[] = [];
	for (const record of records) {
		const item = toCallHierarchyItem(record);
		if (item) {
			out.push(item);
		}
	}
	return out;
}

function renderCallHierarchyItem(
	cwd: string,
	item: CallHierarchyItemLike
): string {
	const uri = item.uri;
	const fsPath = uri ? (diagnosticsKey(uri) ?? uri) : "";
	const range = item.selectionRange ?? item.range;
	const line = (range?.start?.line ?? 0) + 1;
	const column = (range?.start?.character ?? 0) + 1;
	const detail = item.detail?.trim()
		? ` — ${item.detail.trim().slice(0, MAX_SYMBOL_DETAIL_CHARS)}`
		: "";
	const location = fsPath
		? `${displayPath(cwd, fsPath)}:${line}:${column}: `
		: "";
	return `${location}${item.name}${detail} [${symbolKindLabel(item.kind)}]`;
}

/**
 * Walk one direction of the call graph from `item`, returning rendered,
 * indented lines. `incoming` lists the functions that call `item` (marked
 * `←`), `outgoing` the functions `item` calls (marked `→`); the marker is
 * what keeps a deep tree readable without re-reading the direction label.
 *
 * Every level pays one `request`, so the node budget is what keeps a hot call
 * site from turning into dozens of sequential round trips. The graph can also
 * contain cycles (direct recursion shows up immediately), and walking to a
 * bounded depth is what stops those from looping forever.
 */
async function renderCallHierarchyTree(
	runtime: ServerRuntime,
	direction: "incoming" | "outgoing",
	item: CallHierarchyItemLike,
	cwd: string,
	depth: number,
	budget: { nodes: number; truncated: boolean }
): Promise<string[]> {
	if (depth <= 0 || budget.nodes <= 0) {
		return [];
	}
	const method =
		direction === "incoming"
			? "callHierarchy/incomingCalls"
			: "callHierarchy/outgoingCalls";
	const marker = direction === "incoming" ? "←" : "→";
	let raw: LspJsonValue | undefined;
	try {
		// The params carry the VERBATIM item received (its `raw`), never a
		// re-derived copy — see the note on `CallHierarchyItemLike.raw`.
		raw = await request(
			runtime,
			method,
			{ item: item.raw },
			NAVIGATION_TIMEOUT_MS
		);
	} catch (err) {
		// One broken edge must not fail the whole tree; the caller still sees
		// the levels that did resolve.
		log(
			`call hierarchy on "${runtime.config.id}" failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
		);
		return [];
	}
	const children: Array<{ item: CallHierarchyItemLike; label: string }> = [];
	for (const record of Array.isArray(raw) ? raw : []) {
		const entry = asRecord(record);
		if (!entry) {
			continue;
		}
		const child = toCallHierarchyItem(
			direction === "incoming" ? entry.from : entry.to
		);
		if (!child) {
			continue;
		}
		children.push({
			item: child,
			label: `${marker} ${renderCallHierarchyItem(cwd, child)}`,
		});
	}
	if (children.length === 0) {
		return [];
	}
	const lines: string[] = [];
	for (const child of children) {
		if (budget.nodes <= 0) {
			// Set only on an actual cutoff: a tree that ends exactly at the cap
			// with nothing left to walk is complete, not truncated.
			budget.truncated = true;
			break;
		}
		budget.nodes -= 1;
		lines.push(`  ${child.label}`);
		const nested = await renderCallHierarchyTree(
			runtime,
			direction,
			child.item,
			cwd,
			depth - 1,
			budget
		);
		for (const line of nested) {
			lines.push(`  ${line}`);
		}
	}
	return lines;
}

const POSITION_PARAMS = {
	path: Type.String({
		description: "File path, absolute or relative to the working directory.",
	}),
	line: Type.Number({ description: "1-based line number." }),
	column: Type.Optional(
		Type.Number({ description: "1-based column number. Defaults to 1." })
	),
};

// ── Registration ────────────────────────────────────────────────────────────

function registerNavigationTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "lsp_definition",
		label: "Go to Definition",
		description:
			"Jump to where a symbol is defined, using the project's language server. " +
			"Give the file and the 1-based line/column of the symbol. Far more reliable " +
			"than grepping for a name, because it resolves imports, aliases and overloads.",
		promptSnippet: "Resolve a symbol to its definition via the language server",
		parameters: Type.Object(POSITION_PARAMS),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const raw = await request(
				prepared.target.runtime,
				"textDocument/definition",
				{
					textDocument: { uri: prepared.uri },
					position: toPosition(params.line, params.column),
				},
				NAVIGATION_TIMEOUT_MS
			);
			const locations = toLocations(raw);
			return {
				content: [{ type: "text", text: renderLocations(ctx.cwd, locations) }],
				details: { count: locations.length },
			};
		},
	});

	pi.registerTool({
		name: "lsp_references",
		label: "Find References",
		description:
			"List every reference to the symbol at a position, using the project's " +
			"language server. Use this before renaming or deleting something to see " +
			"what actually depends on it.",
		promptSnippet: "Find all references to a symbol via the language server",
		parameters: Type.Object({
			...POSITION_PARAMS,
			includeDeclaration: Type.Optional(
				Type.Boolean({
					description: "Include the declaration itself. Defaults to false.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const raw = await request(
				prepared.target.runtime,
				"textDocument/references",
				{
					textDocument: { uri: prepared.uri },
					position: toPosition(params.line, params.column),
					context: {
						includeDeclaration: params.includeDeclaration === true,
					},
				},
				NAVIGATION_TIMEOUT_MS
			);
			const locations = toLocations(raw);
			return {
				content: [{ type: "text", text: renderLocations(ctx.cwd, locations) }],
				details: { count: locations.length },
			};
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		label: "Hover Info",
		description:
			"Show the resolved type, signature and doc comment of the symbol at a " +
			"position, using the project's language server. Use it to confirm a type " +
			"or an argument list instead of guessing from the source.",
		promptSnippet: "Read a symbol's type and docs via the language server",
		parameters: Type.Object(POSITION_PARAMS),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const raw = await request(
				prepared.target.runtime,
				"textDocument/hover",
				{
					textDocument: { uri: prepared.uri },
					position: toPosition(params.line, params.column),
				},
				NAVIGATION_TIMEOUT_MS
			);
			const text = renderHoverContents(asRecord(raw)?.contents)
				.trim()
				.slice(0, MAX_HOVER_CHARS);
			return {
				content: [{ type: "text", text: text || "No hover information." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "lsp_symbols",
		label: "List Symbols",
		description:
			"List every symbol (function, class, field) in one file as an indented " +
			"outline, using the project's language server. Use it to map a file " +
			"before editing it instead of grepping it twice.",
		promptSnippet: "List a file's symbols via the language server",
		parameters: Type.Object({
			path: Type.String({
				description:
					"File path, absolute or relative to the working directory.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const runtime = prepared.target.runtime;
			if (!serverSupports(runtime, "documentSymbolProvider")) {
				return {
					content: [
						{
							type: "text",
							text: `The "${runtime.config.id}" language server does not support document symbols.`,
						},
					],
					details: {},
				};
			}
			const raw = await request(
				runtime,
				"textDocument/documentSymbol",
				{ textDocument: { uri: prepared.uri } },
				NAVIGATION_TIMEOUT_MS
			);
			return {
				content: [
					{
						type: "text",
						text: renderDocumentSymbols(ctx.cwd, prepared.target.fsPath, raw),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "lsp_symbol_search",
		label: "Search Symbols",
		description:
			"Find every symbol whose name matches a query across the workspace, " +
			"using the running language servers. Use it to locate a definition when " +
			"you only remember its name. Pass `path` to scope the search to the " +
			"server that owns that file; without it, every running server is searched.",
		promptSnippet: "Search the workspace for a symbol by name",
		parameters: Type.Object({
			query: Type.String({
				description: "Symbol name to search for, e.g. createClient or Router.",
			}),
			path: Type.Optional(
				Type.String({
					description:
						"Optional file path; scopes the search to the language server that owns that file's extension.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query;
			if (!query.trim()) {
				return {
					content: [{ type: "text", text: "`query` is required." }],
					details: {},
				};
			}
			const resolved = await symbolSearchServers(params.path, ctx);
			if ("message" in resolved) {
				return {
					content: [{ type: "text", text: resolved.message }],
					details: {},
				};
			}
			const perServer: Array<{
				serverId: string;
				symbols: WorkspaceSymbolLike[];
			}> = [];
			for (const runtime of resolved.servers) {
				try {
					const raw = await request(
						runtime,
						"workspace/symbol",
						{ query: query.trim() },
						NAVIGATION_TIMEOUT_MS
					);
					const symbols = toWorkspaceSymbols(raw);
					if (symbols.length) {
						perServer.push({ serverId: runtime.config.id, symbols });
					}
				} catch (err) {
					// One dead server must not hide the others' answers.
					log(
						`workspace/symbol on "${runtime.config.id}" failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
					);
				}
			}
			return {
				content: [
					{ type: "text", text: renderWorkspaceSymbols(ctx.cwd, perServer) },
				],
				details: {
					count: perServer.reduce(
						(sum, entry) => sum + entry.symbols.length,
						0
					),
				},
			};
		},
	});

	pi.registerTool({
		name: "lsp_implementations",
		label: "Find Implementations",
		description:
			"List every concrete implementation of the interface or class at a " +
			"position, using the project's language server. Use it to find " +
			"everything that inherits or implements a type before changing its " +
			"contract.",
		promptSnippet: "Find implementations of a type via the language server",
		parameters: Type.Object(POSITION_PARAMS),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const runtime = prepared.target.runtime;
			if (!serverSupports(runtime, "implementationProvider")) {
				return {
					content: [
						{
							type: "text",
							text: `The "${runtime.config.id}" language server does not support implementations.`,
						},
					],
					details: {},
				};
			}
			const raw = await request(
				runtime,
				"textDocument/implementation",
				{
					textDocument: { uri: prepared.uri },
					position: toPosition(params.line, params.column),
				},
				NAVIGATION_TIMEOUT_MS
			);
			const locations = toLocations(raw);
			return {
				content: [{ type: "text", text: renderLocations(ctx.cwd, locations) }],
				details: { count: locations.length },
			};
		},
	});

	pi.registerTool({
		name: "lsp_call_hierarchy",
		label: "Call Hierarchy",
		description:
			"Trace who calls a function or what a function calls, as an indented " +
			"tree, using the project's language server. `direction` picks callers " +
			"(incoming) or callees (outgoing), and `depth` bounds how many levels " +
			"are walked.",
		promptSnippet:
			"Trace a function's callers or callees via the language server",
		parameters: Type.Object({
			...POSITION_PARAMS,
			direction: Type.Optional(
				Type.Union([Type.Literal("incoming"), Type.Literal("outgoing")], {
					description:
						"incoming lists the functions that call this one, outgoing lists the functions it calls. Defaults to outgoing.",
				})
			),
			depth: Type.Optional(
				Type.Number({
					description:
						"Levels of the call graph to walk. Defaults to 2, max 4.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = await prepareRequest(params.path, ctx);
			if ("message" in prepared) {
				return {
					content: [{ type: "text", text: prepared.message }],
					details: {},
				};
			}
			const runtime = prepared.target.runtime;
			if (!serverSupports(runtime, "callHierarchyProvider")) {
				return {
					content: [
						{
							type: "text",
							text: `The "${runtime.config.id}" language server does not support call hierarchies.`,
						},
					],
					details: {},
				};
			}
			const direction =
				params.direction === "incoming" ? "incoming" : "outgoing";
			const requestedDepth = params.depth ?? 2;
			const depth = Math.min(
				Math.max(Math.floor(requestedDepth), 1),
				MAX_CALL_HIERARCHY_DEPTH
			);
			const raw = await request(
				runtime,
				"textDocument/prepareCallHierarchy",
				{
					textDocument: { uri: prepared.uri },
					position: toPosition(params.line, params.column),
				},
				NAVIGATION_TIMEOUT_MS
			);
			const items = toCallHierarchyItems(raw);
			const first = items[0];
			if (!first) {
				return {
					content: [
						{ type: "text", text: "No call hierarchy at this position." },
					],
					details: {},
				};
			}
			const budget = { nodes: MAX_CALL_HIERARCHY_NODES, truncated: false };
			const tree = await renderCallHierarchyTree(
				runtime,
				direction,
				first,
				ctx.cwd,
				depth,
				budget
			);
			const lines = [
				`${renderCallHierarchyItem(ctx.cwd, first)} (${direction})`,
				...tree,
			];
			if (budget.truncated) {
				lines.push(
					`…call graph truncated (capped at ${MAX_CALL_HIERARCHY_NODES} nodes)`
				);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "Diagnostics",
		description:
			"Report language-server diagnostics (errors, warnings) for one file, or " +
			"for every file the running language servers have analysed so far when no " +
			"path is given. Use it to check your work after a change, or to see what is " +
			"already broken before you start.",
		promptSnippet: "List language-server errors and warnings",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Optional file path. Omit to report everything currently known.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawPath = params.path;
			if (rawPath?.trim()) {
				return await diagnoseOneFile(rawPath, ctx);
			}
			return diagnoseWorkspace(ctx);
		},
	});
}

interface DiagnosticToolResult {
	content: [{ type: "text"; text: string }];
	details: { count?: number };
}

async function diagnoseOneFile(
	rawPath: string,
	ctx: ExtensionContext
): Promise<DiagnosticToolResult> {
	const prepared = await prepareRequest(rawPath, ctx);
	if ("message" in prepared) {
		return { content: [{ type: "text", text: prepared.message }], details: {} };
	}
	const { fsPath, runtime } = prepared.target;
	// Only wait when the sync actually told the server something new. Otherwise
	// the answer is already in the diagnostics map, and waiting would burn the
	// whole budget before returning exactly that.
	if (prepared.sync?.changed) {
		await waitForDiagnostics(
			runtime,
			fsPath,
			prepared.sync.version,
			ctx.signal
		);
	}
	const diagnostics = currentDiagnostics(
		runtime,
		fsPath,
		prepared.sync?.version
	);
	const text = diagnostics.length
		? formatDiagnosticsBlock(
				ctx.cwd,
				[{ fsPath, diagnostics }],
				MAX_DIAGNOSTICS_REPORTED
			)
		: "No diagnostics.";
	return {
		content: [{ type: "text", text }],
		details: { count: diagnostics.length },
	};
}

/**
 * Report what the ALREADY-RUNNING servers know. This deliberately does not
 * spawn anything: starting every declared server and opening the whole tree to
 * answer one question would be a multi-second, multi-hundred-megabyte surprise.
 */
function diagnoseWorkspace(ctx: ExtensionContext): DiagnosticToolResult {
	const entries: Array<{ fsPath: string; diagnostics: LspDiagnostic[] }> = [];
	for (const runtime of servers.values()) {
		if (runtime.status !== "ready") {
			continue;
		}
		for (const [fsPath, entry] of runtime.diagnostics) {
			// No version gate here: this report is not tied to any one sync, so the
			// latest verdict the server gave for each file is exactly the answer.
			if (entry.diagnostics.length) {
				entries.push({ fsPath, diagnostics: entry.diagnostics });
			}
		}
	}
	const total = entries.reduce(
		(sum, entry) => sum + entry.diagnostics.length,
		0
	);
	const text = total
		? formatDiagnosticsBlock(ctx.cwd, entries, MAX_DIAGNOSTICS_REPORTED)
		: "No diagnostics have been reported by the running language servers.";
	return { content: [{ type: "text", text }], details: { count: total } };
}

/**
 * Resolve which servers a `workspace/symbol` query should hit.
 *
 * A `path` scopes the search to the server that owns that file's extension and
 * warms it if it is cold — the same contract as every other navigation tool.
 * Without one, every ALREADY-READY server that advertises workspace symbols is
 * asked; nothing is spawned, so a cold server you have never touched does not
 * pay an `initialize` for a query you did not point at it.
 */
async function symbolSearchServers(
	rawPath: string | undefined,
	ctx: ExtensionContext
): Promise<{ servers: ServerRuntime[] } | { message: string }> {
	if (rawPath?.trim()) {
		const fsPath = path.resolve(ctx.cwd, rawPath.trim());
		const target = targetFor(fsPath);
		if (!target) {
			const covered = [...extensionOwners.keys()].join(", ") || "none";
			return {
				message: `No language server is configured for ${path.extname(fsPath) || "this file type"} (configured: ${covered}).`,
			};
		}
		if (!(await ensureServer(target.runtime, ctx.cwd))) {
			return {
				message: `The "${target.runtime.config.id}" language server is unavailable; see the Ryu logs for the reason.`,
			};
		}
		if (!serverSupports(target.runtime, "workspaceSymbolProvider")) {
			return {
				message: `The "${target.runtime.config.id}" language server does not support workspace symbol search.`,
			};
		}
		return { servers: [target.runtime] };
	}
	const available: ServerRuntime[] = [];
	for (const runtime of servers.values()) {
		if (
			runtime.status === "ready" &&
			serverSupports(runtime, "workspaceSymbolProvider")
		) {
			available.push(runtime);
		}
	}
	if (available.length === 0) {
		return {
			message:
				"No running language server supports workspace symbol search. Edit or touch a file in a supported language first, which starts its server.",
		};
	}
	return { servers: available };
}

export default async function (pi: ExtensionAPI) {
	// Reading a small local file is not a background resource, so it is safe in
	// the factory — and it has to happen here, because whether we register
	// anything at all depends on the answer.
	const configs = await loadServerConfigs();
	if (configs.length === 0) {
		// COMPLETE NO-OP. No tools, no handlers, no processes. Pi starts exactly as
		// if this extension did not exist.
		return;
	}

	// Tear down anything a previous bind left behind before replacing the
	// registry. Pi emits `session_shutdown` before rebinding, so this is normally
	// a no-op; it exists because jiti may hand back a cached module whose
	// module-level maps survived, and orphaned children would then be unkillable.
	if (servers.size > 0) {
		stopAllServers(servers).catch(() => {
			// Best effort; the replacement registry below is what matters.
		});
	}

	servers = new Map(
		configs.map((config) => [
			config.id,
			{
				config,
				status: "idle",
				child: undefined,
				buffer: Buffer.alloc(0),
				nextRequestId: 1,
				pending: new Map(),
				documents: new Map(),
				diagnostics: new Map(),
				waiters: new Set(),
				serverCapabilities: {},
				restarts: 0,
				starting: undefined,
				stderrTail: "",
				rootPath: process.cwd(),
				shuttingDown: false,
			} satisfies ServerRuntime,
		])
	);
	extensionOwners = claimExtensions(configs);

	/**
	 * THE KEY FEATURE: fold fresh diagnostics into the edit/write tool result the
	 * model is about to read.
	 *
	 * `content` on the returned `ToolResultEventResult` is a WHOLE-ARRAY
	 * REPLACEMENT, not an append — the "omitted fields keep their value" rule is
	 * field-level only. Returning `{ content: [block] }` would silently destroy
	 * the edit tool's own diff output, so the original content is always spread
	 * back in first. Returning `undefined` leaves the result completely untouched,
	 * which is the outcome for every path that is not a clean, claimed, diagnosed
	 * file — including a slow server, an aborted turn, and any unexpected throw.
	 */
	pi.on("tool_result", async (event, ctx) => {
		// The exported guards, not `event.toolName === "edit"`:
		// `CustomToolResultEvent.toolName` is `string` and overlaps every literal,
		// so a direct comparison does not narrow.
		const builtinWrite = isEditToolResult(event) || isWriteToolResult(event);
		if (!(builtinWrite || event.toolName === COPY_PASTE_TOOL)) {
			return;
		}
		if (event.isError) {
			return;
		}
		try {
			const changed: Static<typeof changedPathSchema>[] = [];
			if (builtinWrite) {
				if (Check(changedPathSchema, event.input)) {
					changed.push(event.input);
				}
			} else if (Check(copyPasteInputSchema, event.input)) {
				const { move, path: sourcePath, to_path: destPath } = event.input;
				changed.push({ path: destPath || sourcePath });
				if (move === true && destPath && destPath !== sourcePath) {
					changed.push({ path: sourcePath });
				}
			}
			const blocks: { type: "text"; text: string }[] = [];
			for (const input of changed) {
				const block = await diagnosticsForChangedFile(input, ctx);
				if (block) {
					blocks.push({ type: "text", text: block });
				}
			}
			if (blocks.length === 0) {
				return;
			}
			return { content: [...event.content, ...blocks] };
		} catch (err) {
			log(
				`diagnostics for tool result failed (${errorText(err instanceof Error ? err : new Error(String(err)))}).`
			);
			return;
		}
	});

	registerNavigationTools(pi);

	// Decoration only. Servers are NOT started here: extension factories and
	// session starts both run in invocations that may never touch a claimed file,
	// and a `gopls` spawned per session that nobody uses is pure cost.
	pi.on("session_start", (_event, ctx) => {
		const ids = [...servers.keys()].join(", ");
		withUi(ctx, (ui) => {
			ui.setStatus(RYU_LSP_UI_KEY, `LSP: ${ids}`);
		});
	});

	// Fires for `quit` AND for session replacement (`new` / `resume` / `fork`).
	// Handling replacement is the load-bearing half: pi-acp spawns a fresh Pi RPC
	// process per `session/new`, i.e. one per chat turn, so a server that
	// outlives its session multiplies once per turn until the machine gives out.
	pi.on("session_shutdown", async (_event, ctx) => {
		withUi(ctx, (ui) => {
			ui.setStatus(RYU_LSP_UI_KEY, undefined);
		});
		await stopAllServers(servers);
	});
}
