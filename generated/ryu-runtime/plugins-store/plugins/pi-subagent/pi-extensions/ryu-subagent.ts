/**
 * Ryu subagents — the `Task` tool for the flagship, managed "ryu" (Pi) agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi deliberately ships no sub-agents. Its own `docs/usage.md:309` says so:
 * "It intentionally does not include built-in MCP, sub-agents, permission
 * popups, plan mode, to-dos, or background bash. You can build or install those
 * workflows as extensions or packages." Every other ACP agent Ryu speaks to
 * (Claude Code, Codex) has them, so the DEFAULT agent was the only one that
 * could not delegate a bounded, context-isolated job to a child. This extension
 * closes that gap the way Pi intends: as an extension, shipped from Core next to
 * `ryu-mcp.ts` and `ryu-lsp.ts`.
 *
 * It is a port of Pi's own `examples/extensions/subagent/` with every TUI-only
 * part deleted (`renderCall`, `renderResult`, `formatToolCall`,
 * `formatUsageStats`, `formatTokens`, and the `pi-tui` imports). Those render
 * into a terminal that does not exist here — under ACP the managed Pi is a
 * headless RPC process and the transcript is drawn by Ryu's desktop.
 *
 * THE RENDERING TRICK — WHY THE TOOL IS NAMED EXACTLY `Task`
 * ----------------------------------------------------------
 * pi-acp puts Pi's registered tool NAME straight into the ACP `tool_call.title`
 * (`pi-acp dist/index.js:1001`), and Core's `acp_tool_ui_name`
 * (`apps/core/src/sidecar/adapters/mod.rs`) short-circuits on an exact match
 * against its `KNOWN_TOOLS` list, which already contains `Task`. So a Pi tool
 * literally named `Task` arrives at the client as part type `tool-Task` with
 * `dynamic:false` — lighting up the desktop's existing `SubagentTool` card, the
 * Cowork *Subagents* rail, and the subagent transcript panel with ZERO Core and
 * ZERO desktop change. Renaming this tool to anything else (`subagent`,
 * `delegate`, …) silently downgrades it to a generic tool row. `Agent` is the
 * only other name that would work; it is reserved for a possible second flavour.
 *
 * The input schema keys are fixed by those consumers, not by taste:
 *   - `description`   — `subagent-tool.tsx` reads `part.input?.description` for
 *                       the card subtitle, and `CoworkContextPanel` for the rail
 *                       subtitle. Truncated at 60 chars by the client.
 *   - `prompt`        — `CoworkContextPanel.toSubagentSummary` reconstructs the
 *                       subagent's user turn from `input?.prompt`.
 *   - `subagent_type` — the Cowork label chip; the client defaults it to "Agent".
 * Both `description` and `prompt` are REQUIRED even in parallel mode: those read
 * sites are unconditional, and a missing one renders a blank card with no error
 * anywhere. This is why `tasks` is an addition to them, never a replacement.
 *
 * ONE `Task` CALL === ONE SUBAGENT ROW
 * ------------------------------------
 * `toSubagentSummary` keys a subagent off the `Task` part's own `toolCallId`, so
 * a single call renders as exactly one row with one subtitle and one transcript
 * — even in parallel mode with four children. The per-item `description` /
 * `subagent_type` inside `tasks` are model-facing only; they never become extra
 * rows. Stated here because it will otherwise be rediscovered later and read as
 * a bug.
 *
 * NESTED CHILD TOOL ROWS NEED A CORE FAN-OUT — AND CORE NOW DOES IT
 * ------------------------------------------------------------------
 * The desktop groups a subagent's nested tool rows by splitting the child's
 * `toolCallId` at the first `:` and matching the prefix against the parent Task
 * id (`CoworkContextPanel.tsx::groupSubagentParts`). But `toolCallId` on the ACP
 * wire is the MODEL's own id, passed through verbatim, and Pi's `ExtensionAPI`
 * has no way to emit a synthetic tool call — it can register tools, block them
 * and rewrite their results, nothing more. So an extension CANNOT mint
 * correctly-prefixed sibling frames, and `tool-TaskOutput` is unreachable for
 * the same reason.
 *
 * The degradation is graceful and was designed for: the `SubagentTool` card
 * renders correctly with zero nested rows, and `toSubagentSummary` falls back to
 * `partText(task.output)` for the final answer.
 *
 * CORE CLOSES IT, AND `details.ryuSteps` IS THE CHANNEL. Do NOT read the marker
 * below as speculative dead weight and trim it: `acp.rs::pi_subagent_steps` reads
 * it and emits `AcpEvent::ToolSteps`, and the arm in `sidecar/adapters/mod.rs`
 * mints the `<parent>:<n>` child parts plus a `<parent>:out` `TaskOutput` part
 * from it. Both consumers key on this generic `details.*` marker and on no agent
 * id, which is what keeps the Pi-specific knowledge on this side of the wire. The
 * step budgets (`MAX_RYU_STEPS`, `RYU_STEP_INPUT_FIELD_CAP`) are load-bearing for
 * the same reason: `details` re-rides the ACP `rawOutput` on every update.
 *
 * RECURSION: BOTH HALVES OF THE FIX ARE LOAD-BEARING
 * ---------------------------------------------------
 * A child Pi inherits `PI_CODING_AGENT_DIR`, so it loads THIS extension and
 * re-registers `Task`. Left alone that is a fork bomb, one level at a time. Two
 * things stop it and neither is sufficient alone:
 *   1. the spawn passes `env: { ...process.env, [SUBAGENT_MARKER]: "1" }` — the
 *      upstream example passes NO `env` at all, so the marker would never be set
 *      and the guard below would never fire;
 *   2. the factory early-returns when the marker is already set, so a child
 *      registers no `Task` tool and cannot delegate again.
 *
 * WHAT THE CHILD INHERITS, AND WHY THAT IS DELIBERATE
 * ---------------------------------------------------
 * Inheriting the REST of the parent environment is required, not incidental:
 * `OPENAI_BASE_URL` / `OPENAI_API_KEY` are what keep the child routed through
 * Ryu's Gateway, so its tokens, cost and policy are governed exactly like the
 * parent's. A child spawned with a scrubbed env would either fail to resolve a
 * model or — worse — reach a provider directly, ungoverned.
 *
 * A consequence worth knowing: because `PI_CODING_AGENT_DIR` is inherited, the
 * child also loads `ryu-mcp.ts` and `ryu-lsp.ts`. A `--tools`-scoped child
 * (scout, planner, reviewer) therefore loses `ryu_call_tool`; an unscoped one
 * (worker) keeps MCP and LSP. That is fine, and intentional.
 *
 * MODEL SELECTION: ONE NODE SETTING CAN FORCE EVERY CHILD
 * --------------------------------------------------------
 * The upstream sample agents pin `claude-sonnet-4-5` / `claude-haiku-4-5`, which
 * are passed to the child verbatim and will not resolve against Ryu's
 * gateway-pinned `models.json`. So no built-in agent below declares a model: the
 * child inherits `defaultModel` from the managed `settings.json`, which is the
 * model Ryu already decided this node should use.
 *
 * The plugin registers the node preference `pi-subagent-model`. Empty/unset is
 * the default and means "let the main agent decide": the Task schema exposes an
 * optional requested model, and omitting that request still inherits Pi's
 * managed default. A selected preference is fetched once per Task call and
 * passed to EVERY child with `--model`; it wins over the request, so the main
 * model cannot override an operator's choice. A persona in the optional override
 * file may still name a fallback model, below both choices.
 *
 * SCOPING IS `--tools`, NOT THE GUARD EXTENSION
 * ----------------------------------------------
 * `ryu-plan.ts`'s permission gate no-ops inside a child (it detects the same
 * `RYU_PI_SUBAGENT` marker), because a `--mode json -p` child has
 * `ctx.hasUI === false` and a fail-closed confirm would block EVERY tool in
 * EVERY subagent. A child is therefore narrowed by the `--tools` allowlist on
 * its own command line instead. Hard denials still apply in the child; only the
 * interactive confirm is skipped.
 *
 * ABSENT CONFIG === BUILT-IN DEFAULTS (a deliberate deviation)
 * ------------------------------------------------------------
 * `ryu-lsp.ts` holds "absent config === complete no-op" as its most important
 * robustness property. This file deviates ON PURPOSE, and the reason is the
 * difference between the two features: an LSP tool with no language server
 * configured is useless, whereas a subagent tool with a built-in
 * scout/planner/reviewer/worker persona set is immediately useful with zero
 * setup. The optional `<agentDir>/extensions/ryu-subagents.json` only OVERRIDES
 * and EXTENDS the built-ins.
 *
 * That file is Core/user-owned, next to this extension — it is NOT repo-owned.
 * The upstream example discovered agents from `.pi/agents/*.md` inside the
 * working tree, which is attacker-controlled in any cloned repo, and so it had
 * to raise a trust confirm before running one. Dropping the `.md` discovery is
 * what makes that prompt unnecessary; it was not dropped for convenience.
 *
 * NEVER REGISTER A SLASH COMMAND
 * -------------------------------
 * `pi.registerCommand` is fatal over ACP. Pi's `AgentSession.prompt`
 * short-circuits a registered extension command BEFORE `_runAgentPrompt`, so no
 * `agent_end` event is ever emitted; pi-acp's `startTurn` resolves `pendingTurn`
 * only from `agent_end`, so the ACP `session/prompt` request never returns and
 * the chat spins until Core's turn timeout. This extension registers tools and
 * nothing else. Do not "improve" it with a `/task` command.
 *
 * ORPHAN DISCIPLINE
 * -----------------
 * The child is spawned with `shell: false` and Node's default `detached: false`,
 * so it shares Pi's process group. Do NOT read that as fate-sharing: nothing in
 * Ryu ever signals a process group (pi-acp's `dispose()` and Core's `ChildGuard`
 * both kill a single pid, and no `process_group`/`setsid` exists outside the
 * integration-test harness), and on POSIX a child does not die because its parent
 * did. What actually bounds a child here is that it is awaited INSIDE the `Task`
 * call: the abort ladder (SIGTERM, then SIGKILL after `ABORT_KILL_GRACE_MS`)
 * covers cancel, and a child that outlives its parent Pi still ends its own turn
 * and exits. Keep `detached: false` anyway — its opposite exists precisely so a
 * child SURVIVES the parent, which would leak one Pi (plus its own children) per
 * `Task` call — just do not count it as the guarantee.
 *
 * NO npm DEPENDENCIES, NO SIBLING FILES
 * --------------------------------------
 * Pi loads extensions through jiti with a CLOSED module set (the pi packages,
 * typebox, node built-ins); a `package.json` next to this file would break under
 * Pi's standalone-binary loader, which resolves bare specifiers to nothing. And
 * `ship_pi_extension` copies exactly one `.ts` — no `agents/*.md`, no
 * `prompts/*.md`. The upstream example's agent definitions are therefore inlined
 * as string literals below, and its workflow prompt templates are dropped
 * outright: they would land in Pi's command directory, where pi-acp's
 * `expandSlashCommand` rewrites the user's text before Pi ever sees it.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Constants ───────────────────────────────────────────────────────────────

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-subagent]";

/**
 * Recursion marker. Set on every child's environment and checked at the top of
 * the factory. This name is a CROSS-FILE CONTRACT: `ryu-plan.ts` reads the same
 * variable to no-op its interactive permission confirm inside a child (a
 * `--mode json -p` child has no UI, so a fail-closed confirm would block every
 * tool it tries). Nothing pins the two spellings together — rename in both files
 * or not at all.
 */
const SUBAGENT_MARKER = "RYU_PI_SUBAGENT";

/** Hard cap on `tasks` length. Mirrors the upstream example's own ceiling. */
const MAX_PARALLEL_TASKS = 8;

/** How many children may run at once WITHIN one `Task` call. */
const MAX_CONCURRENCY = 4;

/**
 * Ceiling on `Task` calls in flight across the whole process — the bound that
 * `MAX_PARALLEL_TASKS` and `MAX_CONCURRENCY` do NOT provide.
 *
 * Both of those are per call. Pi executes a message's tool calls concurrently
 * (`pi-agent-core`'s `executeToolCallsParallel` runs them through one
 * `Promise.all`, and nothing here declares `executionMode: "sequential"`), so a
 * model that emits N `Task` calls in one message would otherwise run up to
 * `MAX_CONCURRENCY x N` child Pi processes at once — each a full model turn
 * billed through the Gateway, from a single assistant message, with no ceiling
 * an operator can set. Two concurrent calls is generous for real delegation and
 * caps the process/spend amplification at `MAX_CONCURRENCY x MAX_INFLIGHT_TASKS`.
 */
const MAX_INFLIGHT_TASKS = 2;

/**
 * Per-task cap on the text handed BACK TO THE MODEL in parallel mode. The full
 * output survives in `details.results`, which the model never sees; this bound
 * exists so four verbose children cannot blow the parent's context window.
 */
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Cap on `details.ryuSteps` rows. `details` re-rides the ACP `rawOutput` on
 * EVERY streaming update, so an unbounded step list is quadratic in wire bytes
 * over a long child run. 200 rows is far more tool calls than a bounded subagent
 * task should make, and the model-facing text is unaffected either way.
 */
const MAX_RYU_STEPS = 200;

/** Cap on one step's captured output text, for the same wire-cost reason. */
const RYU_STEP_OUTPUT_CAP = 2000;

/**
 * Cap on any single string ARGUMENT recorded in a step. Truncation is per-field
 * rather than whole-object so the short, identifying keys the desktop's nested
 * rows read (`file_path`, `command`, `pattern`, `path`) always survive intact
 * and only bulk payloads (a `write` body) are clipped.
 */
const RYU_STEP_INPUT_FIELD_CAP = 400;

/** Grace period between SIGTERM and SIGKILL when a turn is aborted. */
const ABORT_KILL_GRACE_MS = 5000;

/** Optional override/extension file, read next to this extension. */
const OVERRIDES_FILE_NAME = "ryu-subagents.json";

/** Manifest-registered node preference that can force every child model. */
const DEFAULT_MODEL_PREF_KEY = "pi-subagent-model";

/** Core endpoint already injected for the managed Pi extension channel. */
const CORE_URL = (
	process.env.RYU_MCP_CORE_URL || "http://127.0.0.1:7980"
).replace(/\/+$/, "");

/** Optional node-admittance bearer for the generic preference endpoint. */
const CORE_TOKEN = process.env.RYU_MCP_CORE_TOKEN || "";

/** Bound preference lookup so unavailable Core never stalls delegation. */
const PREFERENCE_TIMEOUT_MS = 5000;

/** Default persona when the model names none. General-purpose, unrestricted. */
const DEFAULT_SUBAGENT_TYPE = "worker";

/**
 * Characters not allowed in the temp system-prompt filename. Hoisted to module
 * scope because it runs once per spawn and a literal would recompile each time.
 */
const UNSAFE_FILENAME_RE = /[^\w.-]+/g;

/**
 * Allowed persona names. Both sides of this lookup are untrusted — the name is
 * chosen by the MODEL (`subagent_type`) and by whoever wrote the override JSON —
 * and personas live in a plain object, so `__proto__` as an override key would
 * reassign the map's prototype and `constructor` as a `subagent_type` would
 * resolve to a function that looks like a persona until `.systemPrompt` is read.
 * Restricting the alphabet closes both without a Map rewrite.
 */
const AGENT_NAME_RE = /^[\w.-]+$/;

// ── Logging ─────────────────────────────────────────────────────────────────

/**
 * The reason channel is stderr, not `ctx.ui.notify`: over ACP the managed Pi is
 * headless and the UI methods are no-ops. Be honest about where it lands, though
 * — pi-acp sinks its child's stderr into `child.stderr.on("data", () => {})` and
 * forwards none of it, so Core's `acp_subprocess` log carries PI-ACP's stderr,
 * not Pi's. These lines are visible when Pi runs standalone and discarded under
 * Ryu: a debugging aid, never a record. Wrapped because stderr can be closed on
 * a torn-down process and a log line must never break a turn.
 */
function log(message: string): void {
	try {
		process.stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		// Closed stderr on a dying process. Nothing to recover, nothing to break.
	}
}

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ── Agent definitions ───────────────────────────────────────────────────────

interface AgentConfig {
	/** One line, shown to the parent model so it can pick a persona. */
	description: string;
	/** Optional model id. Unset on every built-in — see the preamble. */
	model?: string;
	/** Appended to the child's system prompt via `--append-system-prompt`. */
	systemPrompt: string;
	/** Optional `--tools` allowlist. Unset means the child's full default set. */
	tools?: string[];
}

/**
 * The built-in persona set, inlined from the upstream example's `agents/*.md`.
 * They are string literals rather than sibling files because `ship_pi_extension`
 * ships exactly one `.ts` (see the preamble). No `model` is declared on any of
 * them on purpose: the upstream files pinned Claude model ids that do not
 * resolve against Ryu's gateway-pinned `models.json`.
 */
const BUILTIN_AGENTS: Record<string, AgentConfig> = {
	scout: {
		description:
			"Fast codebase recon that returns compressed context for handoff to another agent",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: [
			"You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.",
			"",
			"Your output will be passed to an agent who has NOT seen the files you explored.",
			"",
			"Thoroughness (infer from the task, default medium):",
			"- Quick: targeted lookups, key files only",
			"- Medium: follow imports, read critical sections",
			"- Thorough: trace all dependencies, check tests and types",
			"",
			"Strategy:",
			"1. grep/find to locate relevant code",
			"2. Read key sections (not entire files)",
			"3. Identify types, interfaces, key functions",
			"4. Note dependencies between files",
			"",
			"Output format:",
			"",
			"## Files Retrieved",
			"List with exact line ranges, one per line: the path, the line range, and what is there.",
			"",
			"## Key Code",
			"The critical types, interfaces or functions, quoted verbatim in fenced code blocks.",
			"",
			"## Architecture",
			"Brief explanation of how the pieces connect.",
			"",
			"## Start Here",
			"Which file to look at first, and why.",
		].join("\n"),
	},
	planner: {
		description:
			"Creates an implementation plan from gathered context and requirements",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: [
			"You are a planning specialist. You receive context (often from a scout) and requirements, then produce a clear implementation plan.",
			"",
			"You must NOT make any changes. Only read, analyze and plan.",
			"",
			"Output format:",
			"",
			"## Goal",
			"One sentence summary of what needs to be done.",
			"",
			"## Plan",
			"Numbered steps, each small and actionable, naming the specific file or function to modify.",
			"",
			"## Files to Modify",
			"One bullet per file: the path, and what changes.",
			"",
			"## New Files (if any)",
			"One bullet per file: the path, and its purpose.",
			"",
			"## Risks",
			"Anything to watch out for.",
			"",
			"Keep the plan concrete. Whoever executes it will follow it verbatim.",
		].join("\n"),
	},
	reviewer: {
		description:
			"Code review specialist for quality, correctness and security analysis",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: [
			"You are a senior code reviewer. Analyze code for quality, security and maintainability.",
			"",
			"You have no shell or network tool. Use only the read-only file and search tools exposed to you.",
			"",
			"Strategy:",
			"1. Run git diff to see recent changes, if applicable",
			"2. Read the modified files",
			"3. Check for bugs, security issues and code smells",
			"",
			"Output format:",
			"",
			"## Files Reviewed",
			"One bullet per file, with the line ranges you actually read.",
			"",
			"## Critical (must fix)",
			"One bullet per issue, prefixed with file and line.",
			"",
			"## Warnings (should fix)",
			"One bullet per issue, prefixed with file and line.",
			"",
			"## Suggestions (consider)",
			"One bullet per idea, prefixed with file and line.",
			"",
			"## Summary",
			"Overall assessment in 2-3 sentences.",
			"",
			"Be specific with file paths and line numbers.",
		].join("\n"),
	},
	worker: {
		description:
			"General-purpose subagent with full capabilities and an isolated context",
		systemPrompt: [
			"You are a worker agent with full capabilities. You operate in an isolated context window to handle a delegated task without polluting the main conversation.",
			"",
			"Work autonomously to complete the assigned task. Use all available tools as needed.",
			"",
			"Output format when finished:",
			"",
			"## Completed",
			"What was done.",
			"",
			"## Files Changed",
			"One bullet per file: the path, and what changed.",
			"",
			"## Notes (if any)",
			"Anything the main agent should know. If handing off to another agent, include the exact file paths changed and a short list of the key functions or types touched.",
		].join("\n"),
	},
};

// ── Override discovery ──────────────────────────────────────────────────────

/**
 * Mirror of Core's `pi_config::config_dir()` resolution, minus the knob Core
 * keeps to itself: `RYU_PI_AGENT_DIR` is Core's override and is NOT present in
 * the Pi child's environment, while `PI_CODING_AGENT_DIR` is the already-
 * resolved value Core passes down. The `~/.ryu/pi-agent` fallback exists only so
 * a hand-run Pi still finds a config; when it is wrong it resolves to "file
 * absent", which is the built-ins-only path and needs no diagnostic.
 */
function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	return path.join(homedir(), ".ryu", "pi-agent");
}

function overridesPath(): string {
	return path.join(agentDir(), "extensions", OVERRIDES_FILE_NAME);
}

/** One raw entry from the override file, before validation. */
interface RawAgentOverride {
	description?: unknown;
	model?: unknown;
	systemPrompt?: unknown;
	tools?: unknown;
}

/** Non-empty trimmed string, or undefined. Rejects every other JSON type. */
function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/** Normalize a `tools` value into a non-empty allowlist, or undefined. */
function optionalTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return;
	}
	const tools: string[] = [];
	for (const entry of value) {
		const name = optionalString(entry);
		if (name) {
			tools.push(name);
		}
	}
	return tools.length > 0 ? tools : undefined;
}

/**
 * Read the manifest-registered forced model. Best-effort: absent, empty,
 * malformed or unreachable preferences all preserve the default inheritance
 * behavior by returning undefined.
 */
async function loadDefaultModel(): Promise<string | undefined> {
	try {
		const headers: Record<string, string> = {};
		if (CORE_TOKEN) {
			headers.authorization = `Bearer ${CORE_TOKEN}`;
		}
		const response = await fetch(
			`${CORE_URL}/api/preferences/${encodeURIComponent(DEFAULT_MODEL_PREF_KEY)}`,
			{
				headers,
				signal: AbortSignal.timeout(PREFERENCE_TIMEOUT_MS),
			}
		);
		if (!response.ok) {
			return;
		}
		const body = (await response.json()) as { value?: unknown };
		return optionalString(body.value);
	} catch {
		return;
	}
}

/**
 * Merge `<agentDir>/extensions/ryu-subagents.json` over the built-ins.
 *
 * Best-effort by construction: an absent, unreadable or malformed file yields
 * the built-ins unchanged, and one bad entry never invalidates the others. A
 * brand-new persona must carry `systemPrompt` — without it there is nothing to
 * send the child, and silently registering an empty persona would look like it
 * worked. Patching an existing built-in may set any subset of the fields.
 */
async function loadAgents(): Promise<Record<string, AgentConfig>> {
	const agents: Record<string, AgentConfig> = { ...BUILTIN_AGENTS };
	const file = overridesPath();
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf-8"));
	} catch (err) {
		// The overwhelmingly common case is "no such file", which is the documented
		// default and deserves no log line. Anything else is worth one.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			log(`ignoring ${file}: ${errorText(err)}`);
		}
		return agents;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		log(`ignoring ${file}: expected a JSON object of agent-name -> config`);
		return agents;
	}

	for (const [rawName, rawEntry] of Object.entries(
		parsed as Record<string, unknown>
	)) {
		const name = rawName.trim();
		if (!AGENT_NAME_RE.test(name)) {
			log(`ignoring override "${rawName}": name must match ${AGENT_NAME_RE}`);
			continue;
		}
		if (!rawEntry || typeof rawEntry !== "object") {
			log(`ignoring override "${name}": not an object`);
			continue;
		}
		const entry = rawEntry as RawAgentOverride;
		const base = agents[name];
		const systemPrompt =
			optionalString(entry.systemPrompt) ?? base?.systemPrompt;
		if (!systemPrompt) {
			log(`ignoring override "${name}": a new agent needs a systemPrompt`);
			continue;
		}
		agents[name] = {
			description:
				optionalString(entry.description) ??
				base?.description ??
				`Custom "${name}" subagent`,
			// A model named here is the override author's responsibility: it is passed
			// to the child verbatim and must resolve against the node's models.json.
			model: optionalString(entry.model) ?? base?.model,
			systemPrompt,
			tools: optionalTools(entry.tools) ?? base?.tools,
		};
	}
	return agents;
}

/** Compact `name: description` listing for the tool description and errors. */
function renderAgentList(agents: Record<string, AgentConfig>): string {
	const names = Object.keys(agents).sort();
	if (names.length === 0) {
		return "none";
	}
	return names.map((name) => `${name}: ${agents[name].description}`).join("; ");
}

// ── Result + step accumulation ──────────────────────────────────────────────

interface UsageStats {
	cacheRead: number;
	cacheWrite: number;
	contextTokens: number;
	cost: number;
	input: number;
	output: number;
	turns: number;
}

/**
 * One tool call the CHILD made, in the shape Core's optional fan-out expects.
 *
 * `name` is the raw Pi tool name (`read`, `bash`, …) stamped verbatim. It is
 * deliberately NOT mapped to the desktop's capitalized `Read`/`Bash` part types
 * here: that mapping is `KNOWN_TOOLS`' job and lives in Core, and duplicating it
 * in an extension asset would give it two homes that drift.
 */
interface RyuStep {
	/** Stable suffix for Core's synthetic `<parent>:<id>` transaction id. */
	id?: string;
	input: Record<string, unknown>;
	name: string;
	output?: string;
	status: "pending" | "completed" | "failed";
}

/**
 * The lifecycle row for one child process.
 *
 * Core already turns every `ryuSteps` entry into a normal nested tool
 * transaction. Naming this one `Agent` deliberately lands it on the desktop's
 * existing subagent renderer, so a parallel `Task` exposes every child spawn
 * independently instead of looking like one opaque parent call.
 */
function childLifecycleStep(
	id: string,
	agentName: string,
	description: string,
	prompt: string
): RyuStep {
	return {
		id,
		input: {
			description,
			prompt,
			subagent_type: agentName,
		},
		name: "Agent",
		status: "pending",
	};
}

interface SingleResult {
	agent: string;
	errorMessage?: string;
	/** -1 while still running; used by the parallel progress line. */
	exitCode: number;
	messages: Message[];
	model?: string;
	ryuSteps: RyuStep[];
	stderr: string;
	stopReason?: string;
	task: string;
	usage: UsageStats;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
	/**
	 * Flattened child tool calls across every result. Core ignores this today;
	 * it is the correlation channel a later Core-side fan-out uses to mint the
	 * nested `<parentId>:<n>` tool parts an extension cannot mint itself.
	 */
	ryuSteps: RyuStep[];
}

function emptyUsage(): UsageStats {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		contextTokens: 0,
		cost: 0,
		input: 0,
		output: 0,
		turns: 0,
	};
}

/** Last assistant text block — the child's final answer. */
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") {
			continue;
		}
		for (const part of msg.content) {
			if (part.type === "text") {
				return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

/** What to show for a result, preferring a diagnostic when it failed. */
function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Byte-bounded truncation of one parallel task's model-facing output. */
function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) {
		return output;
	}
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

/** Per-field truncation of a recorded step's arguments — see the const's note. */
function capStepInput(args: Record<string, unknown>): Record<string, unknown> {
	const capped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > RYU_STEP_INPUT_FIELD_CAP) {
			capped[key] = `${value.slice(0, RYU_STEP_INPUT_FIELD_CAP)}…`;
			continue;
		}
		capped[key] = value;
	}
	return capped;
}

/** Flatten every result's steps into the capped `details.ryuSteps` list. */
function collectRyuSteps(results: SingleResult[]): RyuStep[] {
	const steps: RyuStep[] = [];
	for (const result of results) {
		for (const step of result.ryuSteps) {
			if (steps.length >= MAX_RYU_STEPS) {
				return steps;
			}
			steps.push(step);
		}
	}
	return steps;
}

// ── Child process plumbing ──────────────────────────────────────────────────

/**
 * Resolve how to invoke a nested `pi`.
 *
 * Ported verbatim from the upstream example, and correct under Ryu without
 * change: Core sets `PI_ACP_PI_COMMAND` to `<managed_pi_dir>/node_modules/.bin/pi`,
 * a symlink to `dist/cli.js` behind a node shebang, so `process.argv[1]` exists
 * and the first branch is taken. The bare-`pi`-on-PATH fallback should never
 * fire under Ryu; it is kept for a hand-run Pi and logs when it does, because a
 * silent PATH resolution is exactly the kind of thing that would explain a
 * mysteriously different child later.
 */
function getPiInvocation(args: string[]): { args: string[]; command: string } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	log("falling back to `pi` on PATH; PI_ACP_PI_COMMAND may be unset");
	return { command: "pi", args };
}

/**
 * Write the persona's system prompt to a private temp file.
 *
 * A file rather than an argv string: a persona is multi-kilobyte markdown, and
 * `--append-system-prompt` takes a path. Mode 0600 because the prompt can carry
 * project-specific instructions and the temp dir is world-readable.
 */
async function writePromptToTempFile(
	agentName: string,
	prompt: string
): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "ryu-subagent-"));
	const safeName = agentName.replace(UNSAFE_FILENAME_RE, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** One child NDJSON frame. Only the two fields this file consumes are typed. */
interface ChildEvent {
	message?: Message;
	type?: string;
}

interface RunSingleAgentOptions {
	agentName: string;
	agents: Record<string, AgentConfig>;
	cwd: string | undefined;
	defaultCwd: string;
	lifecycleId: string;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	modelOverride: string | undefined;
	onUpdate: OnUpdateCallback | undefined;
	requestedModel: string | undefined;
	signal: AbortSignal | undefined;
	task: string;
}

/**
 * Spawn one child Pi, stream its NDJSON, and accumulate both the upstream
 * `SingleResult` and this file's `ryuSteps` correlation rows.
 *
 * Never rejects for a child-side failure: an unknown persona, a non-zero exit or
 * a provider error all come back as a `SingleResult` the caller renders. The one
 * throw is an ABORT, which must propagate so Pi marks the whole tool call
 * cancelled rather than reporting a truncated answer as success.
 */
async function runSingleAgent(
	options: RunSingleAgentOptions
): Promise<SingleResult> {
	const {
		agentName,
		agents,
		cwd,
		defaultCwd,
		makeDetails,
		lifecycleId,
		modelOverride,
		onUpdate,
		requestedModel,
		signal,
		task,
	} = options;
	const agent =
		AGENT_NAME_RE.test(agentName) && Object.hasOwn(agents, agentName)
			? agents[agentName]
			: undefined;

	if (!agent) {
		const lifecycle = childLifecycleStep(lifecycleId, agentName, task, task);
		lifecycle.output = `Unknown subagent_type: "${agentName}".`;
		lifecycle.status = "failed";
		return {
			agent: agentName,
			exitCode: 1,
			messages: [],
			ryuSteps: [lifecycle],
			stderr: `Unknown subagent_type: "${agentName}". Available: ${renderAgentList(agents)}.`,
			task,
			usage: emptyUsage(),
		};
	}

	const args = ["--mode", "json", "-p", "--no-session"];
	// The node setting is an operator choice and therefore wins over a persona's
	// optional model. With neither, omission inherits the managed default model.
	const childModel = modelOverride ?? requestedModel ?? agent.model;
	if (childModel) {
		args.push("--model", childModel);
	}
	// Scoping is the child's own allowlist, NOT the guard extension, which
	// deliberately no-ops in children.
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	const lifecycle = childLifecycleStep(lifecycleId, agentName, task, task);
	const currentResult: SingleResult = {
		agent: agentName,
		// The process has been declared but has not exited yet. This exact value is
		// also what parallel progress uses to count running children.
		exitCode: -1,
		messages: [],
		model: childModel,
		ryuSteps: [lifecycle],
		stderr: "",
		task,
		usage: emptyUsage(),
	};

	// Child tool-call id -> its row, so a later `tool_result_end` can close the
	// row the `message_end` opened. The child's ids are its own model's ids and
	// are never shown to Ryu; only the ordered rows are.
	const stepsById = new Map<string, RyuStep>();
	let stepsCapped = false;

	const recordToolCall = (id: string, name: string, args_: unknown): void => {
		if (currentResult.ryuSteps.length >= MAX_RYU_STEPS) {
			if (!stepsCapped) {
				stepsCapped = true;
				log(`ryuSteps capped at ${MAX_RYU_STEPS} for "${agentName}"`);
			}
			return;
		}
		const step: RyuStep = {
			input: capStepInput((args_ ?? {}) as Record<string, unknown>),
			name,
			status: "pending",
		};
		stepsById.set(id, step);
		currentResult.ryuSteps.push(step);
	};

	const recordToolResult = (
		id: string,
		output: string,
		isError: boolean
	): void => {
		const step = stepsById.get(id);
		if (!step) {
			return;
		}
		step.output =
			output.length > RYU_STEP_OUTPUT_CAP
				? `${output.slice(0, RYU_STEP_OUTPUT_CAP)}…`
				: output;
		step.status = isError ? "failed" : "completed";
	};

	const emitUpdate = (): void => {
		if (!onUpdate) {
			return;
		}
		onUpdate({
			content: [
				{
					type: "text",
					text: getFinalOutput(currentResult.messages) || "(running...)",
				},
			],
			details: makeDetails([currentResult]),
		});
	};

	// Publish the lifecycle row before creating the process. Without this first
	// update a quiet child has no visible transaction until its first assistant
	// or tool event, which can be minutes after it was actually spawned.
	emitUpdate();

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agentName, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				// `shell: false` plus Node's default `detached: false` is what puts the
				// child in Pi's process group so it dies with Pi. Do not "fix" either.
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// BOTH HALVES of the recursion fix; the upstream example passes no env
				// at all, which would leave the marker unset and the guard inert.
				env: { ...process.env, [SUBAGENT_MARKER]: "1" },
			});
			let buffer = "";

			const processLine = (line: string): void => {
				if (!line.trim()) {
					return;
				}
				let event: ChildEvent;
				try {
					event = JSON.parse(line) as ChildEvent;
				} catch {
					// Not our frame (a stray log line). Skip it, do not fail the run.
					return;
				}
				const message = event.message;
				if (!message) {
					return;
				}

				if (event.type === "message_end") {
					currentResult.messages.push(message);
					if (message.role !== "assistant") {
						return;
					}
					currentResult.usage.turns++;
					const usage = message.usage;
					if (usage) {
						currentResult.usage.input += usage.input || 0;
						currentResult.usage.output += usage.output || 0;
						currentResult.usage.cacheRead += usage.cacheRead || 0;
						currentResult.usage.cacheWrite += usage.cacheWrite || 0;
						currentResult.usage.cost += usage.cost?.total || 0;
						currentResult.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!currentResult.model && message.model) {
						currentResult.model = message.model;
					}
					if (message.stopReason) {
						currentResult.stopReason = message.stopReason;
					}
					if (message.errorMessage) {
						currentResult.errorMessage = message.errorMessage;
					}
					for (const part of message.content) {
						if (part.type === "toolCall") {
							recordToolCall(part.id, part.name, part.arguments);
						}
					}
					emitUpdate();
					return;
				}

				if (event.type === "tool_result_end") {
					currentResult.messages.push(message);
					if (message.role === "toolResult") {
						recordToolResult(
							message.toolCallId,
							contentText(message.content),
							message.isError
						);
					}
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					processLine(line);
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					processLine(buffer);
				}
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				log(`spawn failed for "${agentName}": ${errorText(err)}`);
				resolve(1);
			});

			if (signal) {
				const killProc = (): void => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) {
							proc.kill("SIGKILL");
						}
					}, ABORT_KILL_GRACE_MS);
				};
				if (signal.aborted) {
					killProc();
				} else {
					signal.addEventListener("abort", killProc, { once: true });
				}
			}
		});

		currentResult.exitCode = exitCode;
		lifecycle.status = isFailedResult(currentResult) ? "failed" : "completed";
		lifecycle.output =
			lifecycle.status === "completed"
				? `Subagent completed with exit code ${exitCode}.`
				: getResultOutput(currentResult);
		emitUpdate();
		if (wasAborted) {
			throw new Error("Subagent was aborted");
		}
		return currentResult;
	} finally {
		if (tmpPromptDir) {
			// `recursive` covers the prompt file too, so there is one cleanup path
			// whether or not the write itself got that far.
			await rm(tmpPromptDir, { force: true, recursive: true }).catch(() => {
				// A leaked temp dir is cosmetic; failing the turn over it is not.
			});
		}
	}
}

/** Run `fn` over `items` with at most `concurrency` in flight, order-preserving. */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
	if (items.length === 0) {
		return [];
	}
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = [];
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		let current = nextIndex++;
		while (current < items.length) {
			results[current] = await fn(items[current], current);
			current = nextIndex++;
		}
	};
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}

// ── Tool schema ─────────────────────────────────────────────────────────────

/**
 * One entry of a parallel fan-out. The keys mirror the top-level ones so there
 * is a single shape to learn. Note that these do NOT become extra subagent rows
 * in the desktop — one `Task` call is one row (see the preamble); they are
 * model-facing labels for the child's own job.
 */
const TaskItem = Type.Object({
	description: Type.String({
		description:
			"Short, specific 3-6 word task name shown to the user. Name the concrete work, not the persona (for example, 'Trace stats data flow').",
	}),
	prompt: Type.String({
		description:
			"The full instruction for this child. It is autonomous and cannot ask follow-up questions, so state everything it needs and what to return.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Model requested for this child when the node setting lets the main agent decide. A configured default subagent model overrides it.",
		})
	),
	subagent_type: Type.Optional(
		Type.String({
			description: "Which persona runs this child. Defaults to worker.",
		})
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for this child. Defaults to the session cwd.",
		})
	),
});

const TaskParams = Type.Object({
	description: Type.String({
		description:
			"Short, specific 3-6 word task name shown to the user. Name the concrete work, not the persona (for example, 'Trace stats data flow').",
	}),
	prompt: Type.String({
		description:
			"The full instruction for the subagent. It runs autonomously in its own context with no access to this conversation and cannot ask follow-up questions, so state everything it needs and exactly what it should return. In parallel mode, describe the overall job here.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Model requested for this child when the node setting lets you decide. A configured default subagent model overrides it.",
		})
	),
	// Deliberately a free string, not a closed StringEnum: the optional
	// `ryu-subagents.json` override file may add personas this schema cannot know
	// about, and a closed enum would make every custom persona unreachable. The
	// resolvable names are listed in the tool description instead, and an unknown
	// name comes back as a result that names the available ones.
	subagent_type: Type.Optional(
		Type.String({
			description:
				"Which persona to run. Defaults to worker. See the tool description for the available personas.",
		})
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: `Optional fan-out: run several independent children concurrently instead of one. Max ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} at a time. Only use it for jobs that do not depend on each other's output.`,
			maxItems: MAX_PARALLEL_TASKS,
		})
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the subagent. Defaults to the session cwd.",
		})
	),
});

// ── Global in-flight accounting ─────────────────────────────────────────────

/**
 * `Task` calls currently running in this process. Module state, like the shell
 * registry in `ryu-shell.ts`, and read/written ONLY in the synchronous prefix of
 * `Task.execute` and in its `finally` — the counter is useless if the check and
 * the increment can interleave, and Pi runs tool calls concurrently.
 */
let inFlightTasks = 0;

// ── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// RECURSION GUARD, half one. A child inherits PI_CODING_AGENT_DIR and so loads
	// this very file; registering `Task` there would let it delegate again, one
	// level deeper, forever. Returning here means a child has no `Task` tool at
	// all. The other half is the explicit `env` on the spawn above — neither works
	// without the other.
	if (process.env[SUBAGENT_MARKER] === "1") {
		log("running as a subagent child; Task is not registered");
		return;
	}

	// Reading one small local file is not a background resource, so it is safe in
	// the factory — and it has to happen here, because the persona list is folded
	// into the tool DESCRIPTION, which is fixed at registration. The list is
	// re-read on every call as well, so editing the override file takes effect on
	// the next Task rather than the next conversation.
	const initialAgents = await loadAgents();

	pi.registerTool({
		name: "Task",
		label: "Task",
		description: [
			"Delegate a self-contained job to a subagent that runs in its own context window and returns only its final answer.",
			"Use it for open-ended search, multi-file investigation, or work whose intermediate output would bloat this conversation.",
			"The subagent cannot ask questions and shares none of this conversation, so `prompt` must be complete on its own and must say what to return.",
			`Available personas: ${renderAgentList(initialAgents)}.`,
		].join(" "),
		promptSnippet: "Delegate a job to a subagent with an isolated context",
		promptGuidelines: [
			"Use Task to delegate open-ended search or multi-step investigation whose intermediate output would bloat the conversation; do not use it for a single file read or one grep you can run directly.",
			"A subagent shares none of this conversation and cannot ask follow-up questions, so put everything it needs in `prompt` and state exactly what it should return.",
			"Write `description` as a specific 3-6 word task name with a concrete action and object. It is the primary label people use to track the subagent, so never put a persona name or generic label such as 'worker' there.",
			"Use the `tasks` array only for jobs that are independent of each other; anything that needs a previous child's output must be a second Task call.",
		],
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Claim a global slot BEFORE the first `await`, so the check and the
			// increment cannot interleave: Pi runs a message's tool calls
			// concurrently, and the per-call caps below bound ONE call, not the
			// number of calls (see `MAX_INFLIGHT_TASKS`).
			if (inFlightTasks >= MAX_INFLIGHT_TASKS) {
				// A result rather than a throw, matching the `MAX_PARALLEL_TASKS`
				// branch below: the model can retry once the running ones finish, and
				// an isError here would read to the user as a failed subagent.
				return {
					content: [
						{
							type: "text",
							text: `Too many subagent tasks are already running (max ${MAX_INFLIGHT_TASKS} at a time). Wait for one to finish and try again.`,
						},
					],
					details: { mode: "single" as const, results: [], ryuSteps: [] },
				};
			}
			inFlightTasks += 1;
			try {
				// Re-read per call so an edited override file is picked up without a new
				// conversation. `loadAgents` never rejects; worst case it is the built-ins.
				const [agents, modelOverride] = await Promise.all([
					loadAgents(),
					loadDefaultModel(),
				]);
				const tasks = params.tasks ?? [];
				const mode: SubagentDetails["mode"] =
					tasks.length > 0 ? "parallel" : "single";

				const makeDetails =
					(detailsMode: SubagentDetails["mode"]) =>
					(results: SingleResult[]): SubagentDetails => ({
						mode: detailsMode,
						results,
						ryuSteps: collectRyuSteps(results),
					});

				if (tasks.length > MAX_PARALLEL_TASKS) {
					// A result rather than a throw: the model can retry with fewer children,
					// and an isError here would read to the user as a failed subagent.
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails(mode)([]),
					};
				}

				if (tasks.length > 0) {
					// Placeholders so the first update already shows the full fan-out with
					// every child marked running (exitCode -1), not a list that grows.
					const allResults: SingleResult[] = tasks.map((task) => ({
						agent: task.subagent_type ?? DEFAULT_SUBAGENT_TYPE,
						exitCode: -1,
						messages: [],
						ryuSteps: [],
						stderr: "",
						task: task.prompt,
						usage: emptyUsage(),
					}));

					const emitParallelUpdate = (): void => {
						if (!onUpdate) {
							return;
						}
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.length - running;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					};

					const results = await mapWithConcurrencyLimit(
						tasks,
						MAX_CONCURRENCY,
						async (task, index) => {
							const result = await runSingleAgent({
								agentName: task.subagent_type ?? DEFAULT_SUBAGENT_TYPE,
								agents,
								cwd: task.cwd ?? params.cwd,
								defaultCwd: ctx.cwd,
								makeDetails: makeDetails("parallel"),
								lifecycleId: `agent-${index}`,
								modelOverride,
								onUpdate: (partial) => {
									const partialResult = partial.details?.results[0];
									if (partialResult) {
										allResults[index] = partialResult;
										emitParallelUpdate();
									}
								},
								signal,
								requestedModel: task.model ?? params.model,
								task: task.prompt,
							});
							allResults[index] = result;
							emitParallelUpdate();
							return result;
						}
					);

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const output = truncateParallelOutput(getResultOutput(r));
						const suffix =
							r.stopReason && r.stopReason !== "end"
								? ` (${r.stopReason})`
								: "";
						const status = isFailedResult(r) ? `failed${suffix}` : "completed";
						return `### [${r.agent}] ${status}\n\n${output}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				}

				const result = await runSingleAgent({
					agentName: params.subagent_type ?? DEFAULT_SUBAGENT_TYPE,
					agents,
					cwd: params.cwd,
					defaultCwd: ctx.cwd,
					makeDetails: makeDetails("single"),
					lifecycleId: "agent-0",
					modelOverride,
					onUpdate,
					requestedModel: params.model,
					signal,
					task: params.prompt,
				});

				if (isFailedResult(result)) {
					// The failure is reported as TEXT, not by throwing and not by an
					// `isError` field. Throwing would discard `details.ryuSteps` and the
					// partial transcript, which is the most useful thing a failed subagent
					// leaves behind; and `isError` is not part of `AgentToolResult` — Pi's
					// agent loop hardcodes `isError: false` for any result a tool RETURNS
					// (`pi-agent-core/dist/agent-loop.js:466`), so the upstream example's
					// `isError: true` here was silently dead. The model reads the text.
					return {
						content: [
							{
								type: "text",
								text: `Subagent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			} finally {
				// Released on every path, including a throw and an abort — a leaked
				// slot would take the ceiling to zero for the rest of the process.
				inFlightTasks -= 1;
			}
		},
	});
}
