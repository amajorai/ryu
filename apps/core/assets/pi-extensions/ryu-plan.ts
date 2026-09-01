/**
 * Ryu plan mode, to-dos and permission prompts — a Pi extension for the
 * flagship, managed "ryu" (Pi) agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi says it, in its own docs (`pi/docs/usage.md:309`):
 *
 *   "It intentionally does not include built-in MCP, sub-agents, permission
 *    popups, plan mode, to-dos, or background bash."
 *
 * Every other ACP agent Ryu drives (Claude Code, Codex) has all of them, so the
 * DEFAULT agent was the only one that could not plan before editing, could not
 * show a checklist, and could not ask before running something destructive. MCP
 * is already closed by `ryu-mcp.ts`; this file closes three more.
 *
 * WHY THREE CAPABILITIES IN ONE FILE
 * ----------------------------------
 * Plan mode and the permission gate are both `tool_call` hooks, and Pi's
 * `emitToolCall` iterates extensions in LOAD ORDER and RETURNS ON THE FIRST
 * `block: true`. Load order depends on whether Core's managed `settings.json`
 * array or Pi's `<agentDir>/extensions/` auto-discovery wins, which is not
 * pinned anywhere and which `ship_pi_extension` (append-only) cannot control.
 * Two `tool_call` hooks in two files would therefore have an unresolvable
 * ordering; ONE hook in ONE file makes the ordering explicit and readable:
 *
 *     plan-mode denial  ->  hard deny  ->  policy confirm
 *
 * To-dos ride along because `TodoWrite` is the tool plan mode tells the model to
 * use, and splitting it out would buy nothing.
 *
 * NEVER REGISTER A SLASH COMMAND HERE. THIS IS NOT A STYLE NOTE.
 * -------------------------------------------------------------
 * `pi.registerCommand("plan", …)` DEADLOCKS the chat when reached over ACP.
 * Pi's `AgentSession.prompt` short-circuits on a registered extension command
 * BEFORE `_runAgentPrompt`, so no `agent_start` and no `agent_end` are ever
 * emitted; rpc mode still replies `success(id, "prompt")`, so pi-acp's
 * `proc.prompt()` RESOLVES, its `.catch` never fires, and the `pendingTurn` it
 * stored in `startTurn` is never settled. The ACP `session/prompt` request never
 * returns and the chat spins until Core's turn timeout.
 *
 * Not registering is also what makes the design below work: Pi's
 * `_tryExecuteExtensionCommand` only matches REGISTERED names, so an
 * unregistered `/plan` falls through as ordinary text and reaches the `input`
 * hook. Register it and you break plan mode and hang the turn in one edit.
 *
 * PLAN-MODE ENTRY: AN IN-BAND SENTINEL, STRIPPED BY THE `input` HOOK
 * -----------------------------------------------------------------
 * Every other candidate channel is dead or wrong:
 *   - `registerFlag("plan")` — pi-acp's argv is hardcoded to
 *     `["--mode","rpc","--no-themes"]`, so `getFlag` returns the default forever.
 *   - a Core-injected env var — env is fixed per pi-acp PROCESS and the spawn
 *     string is part of Core's instance-pool key, so toggling it forks a fresh
 *     Pi and DISCARDS the conversation's context.
 *   - a sibling JSON file (the `ryu-lsp.json` channel) — read in the extension
 *     FACTORY, i.e. once per conversation, not once per turn.
 *   - an HTTP poll against Core — Core keeps no per-turn mode keyed by
 *     conversation, and it would add a round trip to first token.
 *   - `registerCommand` — hangs the turn, see above.
 *
 * The `input` event fires on every prompt with `source: "rpc"` under Ryu, and an
 * `{ action: "transform", text }` result reaches the model verbatim. Both halves
 * were verified on a live Pi turn driven through pi-acp. Worst case if it ever
 * stops firing: the literal token `/plan` leaks into the model's context —
 * visible, harmless, and self-diagnosing.
 *
 * MATCHING RULE (a bare regex-anywhere would false-positive on a pasted diff):
 * the sentinel must be the FIRST LINE OF THE WHOLE TEXT, or the first line of
 * SOME `\n\n`-separated BLOCK, searched from the end. Turn 1 carries
 * `<system preamble>\n\n<short-term context>\n\n<user message>`, so the user's
 * `/plan` heads a block; turn 2+ carries the raw message, so it is the first
 * line overall. Both cases, one rule. (Testing only the FINAL block is not
 * enough: a first message with a blank line of its own pushes the sentinel's
 * block into the middle — see `findSentinel`.)
 *
 * WHO TYPES THE SENTINEL: NOT THE USER, USUALLY
 * ---------------------------------------------
 * It began as something the user types, and typing it still works, but the
 * shipped affordance is the composer's "Plan mode" pill. That pill is a
 * CORE-SYNTHESIZED ACP session-config option (`acp::PLAN_MODE_CONFIG_ID`,
 * `"ryu.plan"`) which no agent has ever heard of, so it cannot be applied over
 * the wire; `apply_plan_mode_sentinel` in `sidecar/adapters/mod.rs` materializes
 * the chosen value into this token instead, and the token's exact spelling lives
 * in `pi_config::plan_mode_sentinel` with a test pinning it against the grammar
 * below. Change the grammar here and that test is what tells you.
 *
 * The composer PERSISTS an option's value per agent, so once the pill is on,
 * every later turn carries the token — which used to mean an approved
 * `ExitPlanMode` was undone one turn later, when the re-sent token re-entered
 * plan mode. That is closed by the CONFIG-WRITEBACK CHANNEL: an approved
 * `ExitPlanMode` returns `details.ryuConfig = { "ryu.plan": "off" }`, Core's
 * agent-neutral `pi_config_updates` reads that marker off the tool result and
 * streams it as a `data-ryu-acp-config` part, and the composer adopts AND
 * persists the value — so the NEXT turn sends `off` and no token is emitted.
 * The marker is generic (`details.*`, like `ryuWidget` / `ryuSteps`): Core keys
 * on the marker alone, never on this tool's name or on Pi, so any extension can
 * ask the client to update a session config value.
 *
 * Only the `on` token is ever emitted (see `apply_plan_mode_sentinel`), so the
 * pill still cannot force plan mode OFF mid-conversation; switching it off stops
 * future turns from re-entering, and `/plan off` is what leaves a plan mode
 * already in progress.
 *
 * THE PLAN INSTRUCTIONS RIDE THE TRANSFORM, NOT `before_agent_start`
 * -----------------------------------------------------------------
 * `before_agent_start`'s `{ systemPrompt }` replacement is NOT verified to reach
 * the provider under rpc mode, and no Ryu extension has ever exercised that
 * event. A silent no-op there would leave plan mode looking wired while the
 * model was never told to plan — it would simply fail at editing. The `input`
 * transform is verified end to end, so the instructions ship inside it.
 *
 * THE RENDERING TRICK — WHY THERE IS ZERO DESKTOP CHANGE
 * -----------------------------------------------------
 * pi-acp puts Pi's registered tool NAME straight into the ACP `title`, and
 * Core's `acp_tool_ui_name` short-circuits on an exact match against its
 * `KNOWN_TOOLS` list. So a Pi tool literally named `TodoWrite` / `PlanWrite` /
 * `ExitPlanMode` arrives at the desktop as `tool-TodoWrite` / … with
 * `dynamic: false` and lands on the existing rich renderers. `rawInput` is the
 * tool's arguments verbatim, which is exactly where the desktop's `TodoTool`
 * reads `input.todos` and `PlanTool` reads `input.plan`. Renaming any of these
 * three tools silently downgrades it to a generic tool row.
 *
 * PERMISSION UI CONTRACT (get this wrong and the prompt reads as nonsense)
 * -----------------------------------------------------------------------
 *   - `ctx.ui.confirm(title, message)` — Ryu's `PermissionPrompt` renders ONLY
 *     `title`, inside the fixed template "allow the agent to {title}?". So
 *     `title` must be a lowercase imperative verb phrase carrying the operand,
 *     no trailing "?", and short. `message` is DISCARDED — we pass "".
 *   - Never `ui.select`: pi-acp maps EVERY option to `kind: "allow_once"` and
 *     the desktop colours on `kind` alone, so a 4-way select renders as four
 *     green ticks with no visible decline.
 *   - Never `ui.input` / `ui.editor`: pi-acp emits a literal chat line saying
 *     the request is unsupported and auto-cancels it.
 *   - Fails closed by construction: any ACP transport failure lands in pi-acp's
 *     `requestExtensionPermission` catch, which answers `{ cancelled: true }`,
 *     so `confirm` resolves `false` and we block.
 *
 * SUBAGENT CHILDREN ARE NOT GATED TO DEATH
 * ----------------------------------------
 * A subagent spawned by `ryu-subagent.ts` runs `pi --mode json -p`, where
 * `hasUI` is false and there is nobody to answer a prompt. A fail-closed
 * `if (!hasUI) block` would block EVERY tool in EVERY subagent. So the CONFIRM
 * branch no-ops in a child (`RYU_PI_SUBAGENT === "1"`); hard denials still
 * apply, and children are scoped with `--tools` instead.
 *
 * WHAT THIS DOES NOT COVER
 * ------------------------
 *   - `bash` is deliberately NOT plan-denied (the model needs it to investigate
 *     before it can plan), so during plan mode `bash` still runs — governed by
 *     the hard denylist and the gateway exec scan below, but not withheld.
 *     That is a known, accepted hole.
 *   - The gateway exec scan is a fail-OPEN hop: if Core cannot be reached the
 *     verdict is skipped and only the local policy applies (see
 *     `scanExecCommand` for why that is the right trade at this hop).
 *   - The permission gate ALLOWS a confirm-worthy call when there is no UI to
 *     ask (an unattended turn), having applied the hard denies and the scan
 *     first. Blocking instead would strand every headless turn. Combined with
 *     the stderr note above, that means an unattended turn can run a
 *     confirm-worthy command with neither a prompt nor a local record — the
 *     gateway's own audit row for the scan is what remains.
 *   - Plan state is persisted best-effort via `appendEntry`. Rehydration after
 *     an idle-TTL pool respawn is UNVERIFIED; if it misses, plan mode falls off
 *     and the user retypes `/plan`. That is an accepted degradation, logged.
 *   - Any policy file added here later would be read in the FACTORY, i.e. once
 *     per conversation, so a settings change would only take effect on the NEXT
 *     chat. Do not add one without saying that in whatever UI exposes it.
 *
 * THE REASON CHANNEL IS STDERR — AND UNDER ACP NOBODY READS IT
 * ------------------------------------------------------------
 * Over ACP the managed Pi is frequently headless, where `ctx.ui.notify` is a
 * no-op, so stderr is what is left. Where it goes, precisely: pi-acp spawns Pi
 * with `stdio: "pipe"` and its ONLY handler for that stream is
 * `child.stderr.on("data", () => {})` — a no-op sink, never forwarded to its own
 * stderr and never put on the ACP wire. Core's `acp_subprocess` WARN log
 * therefore carries PI-ACP's stderr, not Pi's, and every `LOG_PREFIX` line below
 * is visible only when Pi is run standalone.
 *
 * That matters more here than in a debug-only extension, because these lines
 * include the guard's decisions ("hard-denied …", "user declined …", "guard
 * failed …"). TREAT THEM AS A DEBUGGING AID, NOT AS AN AUDIT TRAIL: the only
 * decision that leaves this process at all is the exec scan, which reaches Core
 * and the gateway on the `scanExecCommand` round trip below. Every other verdict
 * here is known only to the model that was refused.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Logging and small helpers ───────────────────────────────────────────────

/** Prefix on every stderr line so Core's `acp_subprocess` log is greppable. */
const LOG_PREFIX = "[ryu-plan]";

/**
 * True when this Pi process is a subagent child spawned by `ryu-subagent.ts`.
 * The confirm branch no-ops here: a `--mode json -p` child has no UI, and
 * failing closed would block every tool in every subagent.
 *
 * `ryu-subagent.ts` now ships as a PLUGIN (`plugins-store/plugins/pi-subagent`) while this
 * file stays compiled into Core, so the two halves of the `RYU_PI_SUBAGENT`
 * contract can be enabled independently. That is safe in one direction only, and
 * it is the direction that can happen: with the subagent plugin disabled no child
 * is ever spawned, so nothing sets the variable and this branch is simply dead.
 * The reverse (a subagent child with no plan extension) cannot occur — this file
 * is unconditional.
 */
const IS_SUBAGENT = process.env.RYU_PI_SUBAGENT === "1";

/**
 * Whitespace-run matcher, hoisted to module scope because it runs on every
 * candidate command and a literal in the function body would recompile it.
 */
const WHITESPACE_RUN_RE = /\s+/g;

function log(message: string): void {
	try {
		process.stderr.write(`${LOG_PREFIX} ${message}\n`);
	} catch {
		// A closed stderr must never break a turn.
	}
}

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Widen an unknown tool input to a readable bag. `ToolCallEvent` is a union
 * whose per-variant `input` types have no index signature, so every read below
 * goes through here rather than through a cast at each call site.
 */
function toRecord(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

/** Read a string field off a tool input, or "" when it is absent/not a string. */
function stringField(input: unknown, key: string): string {
	const value = toRecord(input)[key];
	return typeof value === "string" ? value : "";
}

/**
 * Whether Pi has a dialog-capable UI bound right now.
 *
 * The `ctx.hasUI` read is INSIDE the try on purpose: `hasUI` is a getter that
 * calls `assertActive()` and THROWS once this extension instance is invalidated
 * by a reload or a session replacement. Answering `false` there is correct — a
 * stale instance has no user to ask — and keeps that case distinct from a real
 * guard error, which fails closed instead.
 */
function uiAvailable(ctx: ExtensionContext | undefined): boolean {
	try {
		return Boolean(ctx?.hasUI);
	} catch {
		return false;
	}
}

/**
 * Run `fn` against Pi's UI context, or do nothing at all. Same contract as
 * `ryu-mcp.ts`: UI is decoration, and a mode without a bound uiContext must
 * degrade to silence rather than to a broken turn.
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

// ── Plan-mode state ─────────────────────────────────────────────────────────

/**
 * Whether plan mode is on for this conversation.
 *
 * Module state, and that is deliberate: Core pools ONE Pi process per ACP
 * instance (roughly per conversation), not per turn, so this flag legitimately
 * survives across turns. It is reset only by `/plan off`, by `ExitPlanMode`, or
 * by the pool evicting the instance.
 */
let planMode = false;

/**
 * The active tool set captured at the moment plan mode was entered, restored
 * verbatim on exit. `undefined` means "not currently entered", and is also the
 * idempotency guard: a second `enterPlanMode` would otherwise snapshot the
 * ALREADY-RESTRICTED set and `exitPlanMode` would restore a permanently
 * crippled tool list.
 */
let toolsBeforePlan: string[] | undefined;

/**
 * Tools withheld from the model while plan mode is on: the two file mutators
 * plus the two fan-out tools that would let a plan-mode turn make changes by
 * proxy. `bash` is deliberately absent — the model needs it to investigate
 * before it can plan (see the preamble's "what this does not cover").
 *
 * Note the asymmetry in how the two layers cover these names. `edit` and
 * `write` are Pi built-ins and are always in `getActiveTools()`, so withholding
 * them is the primary enforcement and the `tool_call` block is a backstop.
 * `bash_background`, `Task` and `ryu_call_tool` are registered by SIBLING
 * extensions that may not be loaded at all, so for those the `tool_call` block
 * is the ONLY enforcement — filtering a name that is not in the active set is a
 * harmless no-op.
 */
const PLAN_DENY_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"bash_background",
	"Task",
	// `ryu_call_tool` (registered by the sibling `ryu-mcp.ts`) proxies ARBITRARY
	// Ryu tools through Core, so leaving it out would let a plan-mode turn mutate
	// the filesystem and everything else by proxy — the one path that is neither
	// withheld from the active set nor refused here, and it surfaces nothing.
	"ryu_call_tool",
]);

/** The session-entry `customType` under which the plan flag is persisted. */
const PLAN_ENTRY_TYPE = "ryu-plan";

/** Key for this extension's footer status slot (decoration only, TUI-visible). */
const RYU_PLAN_UI_KEY = "ryu-plan";

/** The sentinel the user types. Never registered as a command — see preamble. */
const PLAN_SENTINEL = "/plan";

/** Block separator Core uses between the preamble, context and user message. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * Matches the sentinel at the head of a candidate LINE. Two things are
 * load-bearing:
 *   - `(-off)?` is part of the SAME alternation as the bare token, so
 *     `/plan-off` cannot be read as "enter, with the rest of the line `-off`";
 *   - `(?![\w-])` stops `/planning` and `/plan-offsite` from matching at all.
 */
const SENTINEL_LINE_RE = /^\/plan(-off)?(?![\w-])[ \t]*(.*)$/;

/** Matches a leading `off` word in the sentinel's remainder (`/plan off …`). */
const SENTINEL_OFF_WORD_RE = /^off(?![\w-])[ \t]*(.*)$/;

/**
 * The plan-mode brief. Shipped INSIDE the `input` transform rather than through
 * `before_agent_start` — see the preamble for why that event is not trusted
 * here. Written as instructions to the model, not as prose to the user.
 */
const PLAN_INSTRUCTIONS = `You are in PLAN MODE.

Do not change anything yet. In this mode the file-mutating tools (edit, write) and any task-delegation tool are withheld, and calls to them are refused. Investigate with read-only tools (read, grep, find, ls, and bash for inspection only) until you understand the problem.

Then:
1. Call TodoWrite with the concrete steps you intend to take, so the user can watch progress.
2. Call PlanWrite with a short title and a markdown summary of the plan: what you will change, in which files, and what could go wrong.
3. Call ExitPlanMode when the plan is ready. That asks the user to approve leaving plan mode, and only then do the mutating tools come back.

Do not claim you have made a change while you are in plan mode. Propose it.`;

/** Appended when the user typed only the sentinel, so the model gets a task. */
const PLAN_ACK_LINE =
	"The user has not described a task yet. Acknowledge that plan mode is on, in one sentence, and ask what they want planned.";

/** Appended when the user typed only `/plan off`, for the same reason. */
const PLAN_OFF_ACK_LINE =
	"Plan mode is off. Acknowledge that in one sentence and wait for the next instruction.";

/** Reason surfaced to the model when plan mode refuses a mutating tool. */
const PLAN_BLOCK_REASON =
	"Plan mode is on — propose the change, then call ExitPlanMode.";

/** Reason surfaced to the model when the user declines a confirmation. */
const USER_DENIED_REASON = "Denied by the user.";

/**
 * Reason surfaced when the guard itself threw. Fail SAFE: Pi's `emitToolCall`
 * has no try/catch of its own, so an exception escaping this handler would be
 * reported as an extension error against an unknown-state tool call. Blocking
 * with a legible reason is strictly better than an ambiguous failure.
 */
const GUARD_ERROR_REASON =
	"Blocked: Ryu's safety guard failed to evaluate this call. Retry, or ask the user to run it.";

/** How much of the prompt head goes into the diagnostic log line. */
const LOG_HEAD_CHARS = 60;

interface SentinelMatch {
	/** `on` enters plan mode, `off` leaves it. */
	action: "on" | "off";
	/** The WHOLE prompt with the sentinel token removed, preamble intact. */
	rest: string;
	/** Only the user's own remainder — what emptiness must be judged on. */
	userRest: string;
	/** Which arm of the matching rule fired; logged, for Gate 0 diagnosis. */
	where: "first-line" | "final-block";
}

/** Split a block into its first line and everything after it. */
function splitFirstLine(block: string): [string, string] {
	const nl = block.indexOf("\n");
	if (nl === -1) {
		return [block, ""];
	}
	return [block.slice(0, nl), block.slice(nl + 1)];
}

/** Rejoin the sentinel line's remainder with the lines that followed it. */
function joinRemainder(remainder: string, tail: string): string {
	if (!remainder) {
		return tail;
	}
	if (!tail) {
		return remainder;
	}
	return `${remainder}\n${tail}`;
}

/** Parse one candidate line. Returns undefined when it is not the sentinel. */
function parseSentinelLine(
	line: string
): { action: "on" | "off"; remainder: string } | undefined {
	const hit = SENTINEL_LINE_RE.exec(line.trimStart());
	if (!hit) {
		return undefined;
	}
	const remainder = (hit[2] ?? "").trim();
	if (hit[1]) {
		// `/plan-off …`
		return { action: "off", remainder };
	}
	const offWord = SENTINEL_OFF_WORD_RE.exec(remainder);
	if (offWord) {
		// `/plan off …`
		return { action: "off", remainder: (offWord[1] ?? "").trim() };
	}
	return { action: "on", remainder };
}

/**
 * Locate the sentinel under the two-arm rule described in the preamble.
 *
 * A bare regex-anywhere is NOT acceptable here: a pasted diff or a quoted file
 * containing a line that starts with `/plan` would silently flip plan mode on
 * mid-conversation and the model would start failing at edits with no visible
 * cause. Only the first line of the whole text, or the first line of the final
 * `\n\n`-separated block, counts.
 */
function findSentinel(text: string): SentinelMatch | undefined {
	// Arm 1 — turn 2+, where Core sends the raw user message as `delta_prompt`
	// and the sentinel is at offset 0.
	const [firstLine, firstTail] = splitFirstLine(text);
	const first = parseSentinelLine(firstLine);
	if (first) {
		const userRest = joinRemainder(first.remainder, firstTail);
		return {
			action: first.action,
			rest: userRest,
			userRest,
			where: "first-line",
		};
	}

	// Arm 2 — turn 1, where Core prepends
	// `<system preamble>\n\n<short-term context>\n\n<user message>` and the
	// sentinel is the first line of the user's own block.
	//
	// Walking the blocks from the END rather than testing only the final one is
	// load-bearing: the user's message is the LAST block only when it contains no
	// blank line of its own. A multi-paragraph first message pushes the block that
	// starts with the sentinel into the middle, `lastIndexOf` lands inside the
	// user's prose, and plan mode silently never engages while the literal token
	// is delivered to the model as text — deterministic, but it reads as flaky
	// because turn 2+ (arm 1) still works.
	//
	// The false-positive surface stays bounded: every candidate still requires the
	// sentinel at the HEAD OF A LINE that directly follows a blank line, so a
	// pasted diff has to contain a paragraph break immediately before a `/plan`
	// line to misfire. The producer is Core (`pi_config::plan_mode_sentinel`,
	// applied by `apply_plan_mode_sentinel`), which always places it exactly so.
	let sep = text.lastIndexOf(BLOCK_SEPARATOR);
	while (sep !== -1) {
		const start = sep + BLOCK_SEPARATOR.length;
		const [blockFirstLine, blockTail] = splitFirstLine(text.slice(start));
		const found = parseSentinelLine(blockFirstLine);
		if (found) {
			const userRest = joinRemainder(found.remainder, blockTail);
			// `head` already ends with the separator, so no separator is re-added
			// here. Adding one is harmless; OMITTING one would fuse the preamble to
			// the user's text, which is why this is spelled out rather than left to
			// the reader.
			return {
				action: found.action,
				rest: text.slice(0, start) + userRest,
				userRest,
				where: "final-block",
			};
		}
		// `sep > 0` is NOT a micro-optimisation: `lastIndexOf` CLAMPS a negative
		// position to 0, so `lastIndexOf(sep, -1)` on a text that starts with a
		// blank line returns 0 forever. This handler is synchronous and runs on
		// every input event, so that loop would wedge Pi's event loop, emit no
		// `agent_end`, and hang the turn to Core's timeout — the exact deadlock the
		// no-slash-command rule exists to avoid. `build_acp_prompt` reaches it with
		// an empty-after-trim preamble or short-term block.
		sep = sep > 0 ? text.lastIndexOf(BLOCK_SEPARATOR, sep - 1) : -1;
	}
	return undefined;
}

/**
 * The text handed to the model when plan mode is entered.
 *
 * The instructions go FIRST, ahead of Core's preamble, deliberately: they are
 * the mode declaration and the model reads them before anything else. Emptiness
 * is judged on `userRest`, not on `rest` — on turn 1 `rest` still carries the
 * whole preamble, so a user who typed nothing but `/plan` would otherwise never
 * reach the acknowledge-and-wait branch.
 */
function planPromptText(match: SentinelMatch): string {
	const body = match.userRest.trim()
		? match.rest
		: `${match.rest}${PLAN_ACK_LINE}`;
	return `${PLAN_INSTRUCTIONS}${BLOCK_SEPARATOR}${body}`;
}

/** The text handed to the model when plan mode is left. */
function offPromptText(match: SentinelMatch): string {
	return match.userRest.trim()
		? match.rest
		: `${match.rest}${PLAN_OFF_ACK_LINE}`;
}

/**
 * Withhold the mutating tools and remember what was active.
 *
 * MUST be called from an event handler, never from the factory body: Pi's
 * action methods throw "Extension runtime not initialized. Action methods
 * cannot be called during extension loading."
 *
 * Idempotent by the `toolsBeforePlan` guard — see that field's comment for the
 * crippled-tool-list failure this prevents.
 */
function enterPlanMode(pi: ExtensionAPI): void {
	if (toolsBeforePlan !== undefined) {
		return;
	}
	try {
		const active = pi.getActiveTools();
		pi.setActiveTools(active.filter((name) => !PLAN_DENY_TOOLS.has(name)));
		// Assigned only after `setActiveTools` succeeded, so a throw leaves the
		// guard clear and the next attempt can still snapshot the real set.
		toolsBeforePlan = [...active];
	} catch (err) {
		// The `tool_call` denial below still holds the line on its own; this is
		// the belt, not the braces.
		log(`could not withhold mutating tools (${errorText(err)}).`);
	}
}

/** Restore the tool set captured by `enterPlanMode`. Idempotent. */
function exitPlanMode(pi: ExtensionAPI): void {
	const saved = toolsBeforePlan;
	if (!saved) {
		return;
	}
	try {
		pi.setActiveTools(saved);
		// Cleared only AFTER the restore succeeded — the mirror image of
		// `enterPlanMode`, and for the mirror-image reason. Clearing first would
		// mean a throwing `setActiveTools` (a stale extension runtime) discarded
		// the snapshot for good: `edit`/`write`/`Task` would stay withheld for the
		// rest of the conversation with `planMode` already `false`, so nothing
		// would report why, and the next `/plan` would snapshot the crippled set.
		toolsBeforePlan = undefined;
	} catch (err) {
		log(
			`could not restore the tool set (${errorText(err)}); keeping the snapshot.`
		);
	}
}

/**
 * Persist the plan flag into the session so a reload can pick it up. Strictly
 * best-effort: `appendEntry` throws on a stale runtime, and losing the flag
 * costs the user one retyped `/plan`.
 */
function persistPlanState(pi: ExtensionAPI): void {
	try {
		pi.appendEntry(PLAN_ENTRY_TYPE, { enabled: planMode });
	} catch (err) {
		log(`could not persist plan state (${errorText(err)}).`);
	}
}

/**
 * Read the last persisted plan flag out of the session entries, or undefined
 * when this extension has never written one.
 */
function readPersistedPlanState(
	ctx: ExtensionContext | undefined
): boolean | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() as
		| Array<{ customType?: string; data?: unknown; type?: string }>
		| undefined;
	if (!Array.isArray(entries)) {
		return undefined;
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) {
			continue;
		}
		const enabled = toRecord(entry.data).enabled;
		if (typeof enabled === "boolean") {
			return enabled;
		}
		// A malformed row is SKIPPED, not terminal. Returning undefined here would
		// let one bad entry shadow every good one before it, and the caller would
		// log "no persisted plan state" — indistinguishable from never having
		// written one. R7 requires the rehydrate miss to be visible; conflating
		// those two cases is exactly how it stops being.
	}
	return undefined;
}

/**
 * Paint the plan flag into Pi's own footer. Pure decoration, and invisible over
 * ACP (the managed Pi is headless there) — it exists so the same file is honest
 * in a TUI. Guarded and swallowed by `withUi`, so it can never break a turn.
 */
function paintPlanStatus(ctx: ExtensionContext | undefined): void {
	withUi(ctx, (ui) => {
		ui.setStatus(RYU_PLAN_UI_KEY, planMode ? "Plan mode" : undefined);
	});
}

// ── Permission policy ───────────────────────────────────────────────────────

/**
 * Commands refused outright, with no prompt, because no plausible answer to
 * "are you sure?" makes them recoverable. Checked BEFORE the confirm list, so
 * an overlap between the two lists is dead weight rather than a conflict.
 *
 * This list is deliberately short. It is a floor under the model's judgement,
 * not a sandbox — the real containment story is Core's exec scan, which does
 * not yet see Pi's bash at all (see the preamble).
 */
const DENY_BASH_PATTERNS: readonly RegExp[] = [
	// Any rm invocation rooted at `/`, including split flags, `--`, and a
	// `sudo` option. A root-targeted recursive delete is never a confirmation
	// prompt: the process runner and the gateway scanner are defense in depth,
	// but this local floor must also catch their outage/fallback path.
	/(?:^|[|;&\n]\s*|\bsudo\s+(?:-[a-zA-Z-]+\s+)*)rm\s+(?:(?:-[a-zA-Z-]+)\s+)*\/+\.?\/*\s*(?:\*\s*)?(?:--[a-zA-Z-]+\s*)*$/,
	// Formatting a filesystem destroys every file on it. Anchored to the head of
	// a command segment, like the `sudo` rule below: a bare `\b` word match also
	// fires on `grep mkfs .`, and a HARD deny (no prompt, no override) that
	// refuses a read-only search is worse than the risk it is guarding.
	/(?:^|[|;&\n]\s*|\bsudo\s+)mkfs(?:\.[a-z0-9]+)?\b/,
	// `dd` onto a raw block device destroys the disk, partition table included.
	/\bdd\b[^\n]*\bof\s*=\s*\/dev\/(?:disk|[hsv]d|nvme|mmcblk|xvd|vd)/,
	// Other raw-disk tools are equally destructive even though they do not use
	// `rm`. Keep them in the unconditional floor so approval mode/fallback cannot
	// turn a storage wipe or partition rewrite into an executable plan.
	/(?:^|[|;&\n]\s*|\bsudo\s+)(?:wipefs|blkdiscard|fdisk|sfdisk|parted|partprobe|gpart)\b[^\n]*\/dev\//,
	/(?:^|[|;&\n]\s*|\bsudo\s+)diskutil\s+(?:eraseDisk|partitionDisk)\b/,
	/\b(?:format\s+[a-z]:|(?:Clear-Disk|Initialize-Disk|Remove-Partition|Format-Volume)\b)/i,
	// The classic fork bomb, which takes the machine down with it.
	/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	// Powering the machine down would kill this session, Core, and the desktop.
	// Anchored for the same reason as `mkfs` above — unanchored, this refused
	// `grep -rn reboot .`, `rg poweroff` and even `latexmk -halt-on-error`
	// (a `-` is a word boundary), with a reason that was factually wrong about
	// what the command did.
	/(?:^|[|;&\n]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b/,
	// Making `/` world-writable is an unrecoverable system-wide change.
	/\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\/\s*$/,
];

/**
 * Commands that are legitimate but destructive enough that a human should see
 * them first. Every one of these is something a user would reasonably want to
 * stop mid-turn; nothing here is merely "unusual".
 */
const CONFIRM_BASH_PATTERNS: readonly RegExp[] = [
	// Any recursive delete, wherever it points.
	/\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR]/,
	// Privilege escalation, including behind a pipe or `&&`.
	/(?:^|[\s|;&(])sudo\s/,
	// World-writable permissions, and any ownership change.
	/\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/,
	/\bchown\b/,
	// Piping a download straight into a shell — remote code execution by design.
	/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|d)?sh\b/,
	// `dd` writing anywhere at all.
	/\bdd\b[^\n]*\bof=/,
	// Rewriting published history. `--force-with-lease` is excluded on purpose.
	/\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/,
	// Throwing away uncommitted work.
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*[fdx]/,
	// Publishing to a public registry is not undoable.
	/\b(?:npm|pnpm|bun|yarn)\s+publish\b/,
	// Killing processes by name can take out Core, the desktop, or the user's app.
	/\b(?:pkill|killall)\b/,
];

// ── Gateway exec scan (Core round trip) ─────────────────────────────────────
//
// Core's exec/write scan runs ONLY inside its ACP `request_permission` handler,
// and Pi never sends `request_permission` — so the flagship's `bash` was the one
// agent's shell that reached the machine with no gateway governance at all. The
// denylist above narrows that; `POST /api/exec/scan` closes it. It is a thin
// proxy to `gateway::check_exec_scan`, keeping that function's fail-closed
// semantics (an unreachable or unparseable gateway is a `deny`), and it answers
// EVERY verdict with HTTP 200 including `deny` — precisely so a deny cannot be
// mistaken here for a transport failure.
//
// The credentials are the ones Core already injects into the Pi spawn for
// `ryu-mcp.ts` (`RYU_MCP_CORE_URL` / `RYU_MCP_CORE_TOKEN` / `RYU_MCP_AGENT_ID`),
// and `/api/exec/scan` sits on the same `protected` router as
// `/api/mcp/tools/call`, so no new credential exists to be provisioned or to go
// stale. A subagent child inherits them with the rest of the environment.

/** Core's own base URL, injected into the Pi spawn. Loopback in practice. */
const CORE_URL = (
	process.env.RYU_MCP_CORE_URL || "http://127.0.0.1:7980"
).replace(/\/+$/, "");

/** Core node-admittance bearer. Absent when the node runs without auth. */
const CORE_TOKEN = process.env.RYU_MCP_CORE_TOKEN || "";

/** Attribution only — it tags the gateway's audit row and grants nothing. */
const SCAN_AGENT_ID = process.env.RYU_MCP_AGENT_ID || "ryu";

/**
 * Hard bound on the scan round trip. A safety check that hangs a turn is worse
 * than one that is occasionally skipped, and Core's own gateway call is already
 * bounded — this only covers a half-open loopback socket, where a fetch would
 * otherwise never settle.
 */
const SCAN_TIMEOUT_MS = 5000;

/** Verdict vocabulary, round-tripped from the gateway rather than renamed. */
type ScanDecision = "allow" | "approval_required" | "deny";

interface ScanVerdict {
	decision: ScanDecision;
	reason?: string;
}

/**
 * Ask Core whether this command may run.
 *
 * Returns `undefined` on ANY failure — unreachable Core, non-2xx, malformed
 * body, timeout — and the caller then falls back to the local policy. That is a
 * deliberate fail-OPEN at this hop and it is not the last word: the endpoint
 * itself fails closed on an unreachable gateway, so "Core answered" is the only
 * case where a verdict exists at all, and the local denylist plus the user
 * confirmation still stand behind this. Failing closed here instead would mean a
 * Core restart mid-turn bricks every shell command the agent tries.
 */
async function scanExecCommand(
	command: string
): Promise<ScanVerdict | undefined> {
	try {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (CORE_TOKEN) {
			headers.authorization = `Bearer ${CORE_TOKEN}`;
		}
		const res = await fetch(`${CORE_URL}/api/exec/scan`, {
			method: "POST",
			headers,
			body: JSON.stringify({ agent_id: SCAN_AGENT_ID, command }),
			signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
		});
		if (!res.ok) {
			log(
				`exec scan unavailable (HTTP ${res.status}); using the local policy.`
			);
			return undefined;
		}
		const body = (await res.json()) as ScanVerdict;
		const decision = body?.decision;
		if (
			decision !== "allow" &&
			decision !== "approval_required" &&
			decision !== "deny"
		) {
			log("exec scan returned an unknown decision; using the local policy.");
			return undefined;
		}
		return {
			decision,
			reason: typeof body.reason === "string" ? body.reason : undefined,
		};
	} catch (err) {
		log(`exec scan failed (${errorText(err)}); using the local policy.`);
		return undefined;
	}
}

/**
 * Path fragments whose files carry credentials, repository history, or a
 * dependency tree that is expensive to rebuild. Matched against the write/edit
 * target, not against the command line.
 */
const CONFIRM_WRITE_PATHS: readonly string[] = [
	".env",
	".git/",
	"id_rsa",
	".ssh/",
	"node_modules/",
];

/**
 * Longest command head folded into a confirm title. Budgeted so that
 * "run `" + head + "`" stays inside the ~60 chars the prompt template can show
 * without wrapping, and so truncation never lands INSIDE the backticks.
 */
const COMMAND_HEAD_CHARS = 48;

/** Tools whose input is a shell command, i.e. that the bash rules apply to. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "bash_background"]);

/** Tools that write to a path, mapped to the verb the prompt should use. */
const PATH_TOOL_VERBS: Readonly<Record<string, string>> = {
	edit: "edit",
	write: "overwrite",
};

/** Collapse a command to one line and cap it, for a legible prompt title. */
function commandHead(command: string): string {
	const oneLine = command.replaceAll(WHITESPACE_RUN_RE, " ").trim();
	return oneLine.length <= COMMAND_HEAD_CHARS
		? oneLine
		: `${oneLine.slice(0, COMMAND_HEAD_CHARS - 1)}…`;
}

/** Final path segment, tolerating both separators. */
function baseName(target: string): string {
	const normalized = target.replaceAll("\\", "/").replace(/\/+$/, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/** Whether a write/edit target is one of the sensitive paths above. */
function pathNeedsConfirm(target: string): boolean {
	const normalized = target.replaceAll("\\", "/");
	const base = baseName(normalized);
	for (const needle of CONFIRM_WRITE_PATHS) {
		if (
			needle.endsWith("/") ? normalized.includes(needle) : base.includes(needle)
		) {
			return true;
		}
	}
	return false;
}

/**
 * A hard refusal for this call, or undefined. The returned string is the reason
 * the MODEL sees, so it names the command and says why, rather than just "no".
 */
function hardDeny(toolName: string, input: unknown): string | undefined {
	if (!COMMAND_TOOLS.has(toolName)) {
		return undefined;
	}
	const command = stringField(input, "command");
	if (!command) {
		return undefined;
	}
	for (const pattern of DENY_BASH_PATTERNS) {
		if (pattern.test(command)) {
			return `Refused by Ryu's local safety policy: \`${commandHead(command)}\` is irreversible. Ask the user to run it themselves if that is really what they want.`;
		}
	}
	return undefined;
}

/**
 * The confirmation to raise for this call, or undefined when none is needed.
 *
 * `title` is the WHOLE rendered message: Ryu wraps it as
 * "allow the agent to {title}?". Hence lowercase, imperative, operand included,
 * no trailing "?".
 */
function needsConfirm(
	toolName: string,
	input: unknown
): { title: string } | undefined {
	if (COMMAND_TOOLS.has(toolName)) {
		const command = stringField(input, "command");
		if (!command) {
			return undefined;
		}
		for (const pattern of CONFIRM_BASH_PATTERNS) {
			if (pattern.test(command)) {
				return { title: `run \`${commandHead(command)}\`` };
			}
		}
		return undefined;
	}
	const verb = PATH_TOOL_VERBS[toolName];
	if (!verb) {
		return undefined;
	}
	const target = stringField(input, "path");
	if (!(target && pathNeedsConfirm(target))) {
		return undefined;
	}
	return { title: `${verb} ${baseName(target)}` };
}

// ── Tool result rendering ───────────────────────────────────────────────────

/** A to-do row, as the desktop's `TodoTool` reads it off `input.todos`. */
interface TodoItem {
	activeForm?: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

/** The to-do statuses. A `StringEnum`, never `Type.Union` — see below. */
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

/** Glyphs for the model-facing echo of the list. The desktop renders its own. */
const TODO_GLYPHS: Readonly<Record<string, string>> = {
	completed: "[x]",
	in_progress: "[~]",
	pending: "[ ]",
};

/**
 * The last list written this session, echoed back so a follow-up TodoWrite can
 * be reasoned about against it. Display/context only — the desktop reads
 * `input.todos`, never this.
 */
let lastTodos: TodoItem[] = [];

/** Render the list for the model. The desktop ignores tool output entirely. */
function renderTodos(todos: TodoItem[]): string {
	if (todos.length === 0) {
		return "The to-do list is now empty.";
	}
	const done = todos.filter((t) => t.status === "completed").length;
	const lines = todos.map(
		(t) => `${TODO_GLYPHS[t.status] ?? "[ ]"} ${t.content}`
	);
	return `${done}/${todos.length} done\n${lines.join("\n")}`;
}

// ── Registration ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// NO BACKGROUND RESOURCES AND NO ACTION METHODS IN THE FACTORY. Pi throws
	// "Extension runtime not initialized" for `getActiveTools`/`setActiveTools`
	// here; every call to them below is inside an event handler.
	//
	// AND NO `pi.registerCommand(…)`, EVER — see the preamble. `/plan` must fall
	// through Pi's command dispatch as plain text to reach the `input` hook, and
	// a registered extension command reached over ACP deadlocks the turn.

	/**
	 * The to-do list. The name `TodoWrite` is a WIRE CONTRACT with the desktop,
	 * not a label: pi-acp copies it into the ACP `title` and Core's
	 * `acp_tool_ui_name` matches that against `KNOWN_TOOLS` to produce
	 * `tool-TodoWrite`, which is what selects the checklist renderer. `label` is
	 * cosmetic and pi-acp never reads it.
	 */
	pi.registerTool({
		name: "TodoWrite",
		label: "Todos",
		description:
			"Write the task list for the current piece of work. Always send the COMPLETE list, " +
			"not a delta: the list you send replaces the previous one and is what the user sees. " +
			"Mark exactly one item as in_progress at a time, and mark it completed before " +
			"starting the next one.",
		promptSnippet: "Track multi-step work as a live to-do list",
		promptGuidelines: [
			"Use TodoWrite as soon as a request needs more than two steps, and update it as each step completes — the user watches this list to know where you are.",
			"Send the whole list every time; TodoWrite replaces the previous list rather than merging into it.",
		],
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({
						description:
							"The step, in the imperative — e.g. 'add the health endpoint'.",
					}),
					// StringEnum, NOT Type.Union/Type.Literal: the union form emits
					// anyOf/const, which Google's API rejects outright.
					status: StringEnum(TODO_STATUSES, {
						description: "Current state of this step.",
					}),
					activeForm: Type.Optional(
						Type.String({
							description:
								"Present-continuous form shown while the step runs — e.g. 'adding the health endpoint'.",
						})
					),
				}),
				{
					description:
						"The complete task list, in order. Replaces any previous list.",
				}
			),
		}),
		async execute(_toolCallId, params) {
			const todos = (toRecord(params).todos ?? []) as TodoItem[];
			lastTodos = Array.isArray(todos) ? todos : [];
			return {
				content: [{ type: "text", text: renderTodos(lastTodos) }],
				// The desktop reads `part.input.todos`, never the output, so this
				// shape is free — it exists so the model can see what it just wrote.
				details: { todos: lastTodos },
			};
		},
	});

	/**
	 * The plan artifact. `input.plan` is the desktop contract: `PlanTool` returns
	 * NULL when `plan` is missing, so a malformed argument renders as a blank
	 * region in the transcript rather than as an error. Hence `plan` is required
	 * and `title` inside it is required.
	 */
	pi.registerTool({
		name: "PlanWrite",
		label: "Plan",
		description:
			"Publish the plan for the current piece of work as a document the user can read and " +
			"approve. Call this once the investigation is done and before calling ExitPlanMode.",
		promptSnippet: "Publish a written plan for the user to approve",
		promptGuidelines: [
			"In plan mode, call PlanWrite with a short title and a markdown summary before calling ExitPlanMode.",
			"The summary should say what you will change, in which files, and what could go wrong — not restate the request.",
		],
		parameters: Type.Object({
			plan: Type.Object({
				title: Type.String({
					description:
						"One line naming the change, e.g. 'Add a health endpoint'.",
				}),
				summary: Type.Optional(
					Type.String({
						description:
							"The plan itself, as markdown: the steps, the files touched, and the risks.",
					})
				),
				id: Type.Optional(
					Type.String({
						description:
							"Optional slug used as the plan's filename chip, e.g. 'health-endpoint'.",
					})
				),
			}),
		}),
		async execute(_toolCallId, params) {
			const plan = toRecord(toRecord(params).plan);
			const title = typeof plan.title === "string" ? plan.title : "";
			if (!title.trim()) {
				// Throwing marks the result isError:true and reports it to the model,
				// which is far better than the desktop silently rendering nothing.
				throw new Error(
					"PlanWrite: `plan.title` is required — the plan card renders nothing without it."
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Plan published: ${title}. Call ExitPlanMode when you are ready to start making changes.`,
					},
				],
				details: { plan },
			};
		},
	});

	/**
	 * Leave plan mode, with the user's consent.
	 *
	 * This is the ONLY approval path. The Approve button on the desktop's plan
	 * card is visual only — its `onApprove` is a function and cannot cross the
	 * ACP wire — so approval has to be a real `ctx.ui.confirm` raised from here.
	 */
	pi.registerTool({
		name: "ExitPlanMode",
		label: "Exit Plan Mode",
		description:
			"Ask the user to approve leaving plan mode and starting the work. Call this only " +
			"after the plan has been published with PlanWrite. If the user declines, stay in " +
			"plan mode and revise the plan.",
		promptSnippet: "Ask the user to approve the plan and leave plan mode",
		parameters: Type.Object({
			plan: Type.Optional(
				Type.String({
					description:
						"Optional one-line restatement of what you are about to do.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planMode) {
				return {
					content: [
						{
							type: "text",
							text: "Plan mode is not on; the mutating tools are already available.",
						},
					],
					details: { exited: false, reason: "not-in-plan-mode" },
				};
			}
			// FAILS CLOSED, unlike the `tool_call` confirm branch, and the asymmetry
			// is deliberate. There, a fail-closed no-UI path would block EVERY tool
			// in EVERY subagent (design R9). Here, the cost of failing closed is one
			// refused tool call with a legible reason — the model can revise and the
			// user can always type `/plan off`. So "nobody could be asked" gets the
			// same answer as "the confirm threw": plan mode stays on.
			//
			// This branch is near-dead on the flagship path anyway: `hasUI` is TRUE
			// under pi-acp's rpc mode (verified on a live turn). It fires only for a
			// stale context, or in a subagent child — and a child never entered plan
			// mode in the first place (entry is the `input` hook, and a child's
			// prompt comes from `ryu-subagent.ts`, not from a user typing `/plan`),
			// so it takes the `!planMode` branch above and never reaches here.
			let approved = false;
			if (!IS_SUBAGENT && uiAvailable(ctx)) {
				try {
					// Title is the whole rendered message: "allow the agent to {title}?".
					approved = await ctx.ui.confirm(
						"leave plan mode and start making changes",
						""
					);
				} catch (err) {
					log(
						`ExitPlanMode confirm failed (${errorText(err)}); staying in plan mode.`
					);
					approved = false;
				}
			} else {
				log("ExitPlanMode: no UI to ask; staying in plan mode.");
			}
			if (!approved) {
				return {
					content: [
						{
							type: "text",
							text: "The plan was not approved, so plan mode stays on. Revise the plan and publish it again with PlanWrite.",
						},
					],
					details: { exited: false, reason: "not-approved" },
				};
			}
			planMode = false;
			exitPlanMode(pi);
			persistPlanState(pi);
			paintPlanStatus(ctx);
			log("plan mode OFF (ExitPlanMode approved).");
			const note = stringField(params, "plan");
			return {
				content: [
					{
						type: "text",
						text: `Plan approved — plan mode is off and the mutating tools are available again.${note ? `\nProceeding with: ${note}` : ""}`,
					},
				],
				// `ryuConfig` is the generic "client, update these session config
				// values" marker Core reads off any tool result (`pi_config_updates`
				// → `data-ryu-acp-config`). Here it clears the composer's persisted
				// Plan mode pill, which is what stops the NEXT turn's re-sent `/plan`
				// token from undoing this approval. Stamped ONLY on the approved
				// branch: the declined and not-in-plan-mode branches above must leave
				// the user's pill exactly as they set it.
				details: { exited: true, ryuConfig: { "ryu.plan": "off" } },
			};
		},
	});

	/**
	 * PLAN-MODE ENTRY. The one and only entry point — see the preamble for why
	 * every other channel is dead.
	 *
	 * This handler ALWAYS logs one line, including when no sentinel is found.
	 * That is what makes the failure modes distinguishable: no line at all means
	 * the `input` event is not firing under ACP at all, whereas a line with
	 * `action=none` on a turn where the user did type `/plan` means the matching
	 * rule is wrong for the observed text shape. Without the always-log, those
	 * two look identical from the log and the wrong thing gets "fixed".
	 */
	pi.on("input", (event, ctx) => {
		try {
			const text = typeof event.text === "string" ? event.text : "";
			const match = findSentinel(text);
			const head = text
				.slice(0, LOG_HEAD_CHARS)
				.replaceAll(WHITESPACE_RUN_RE, " ");
			log(
				`input source=${event.source} len=${text.length} action=${match?.action ?? "none"} where=${match?.where ?? "-"} head="${head}"`
			);
			if (!match) {
				// No sentinel: fall through as `continue`, prompt untouched.
				return;
			}
			if (match.action === "on") {
				planMode = true;
				enterPlanMode(pi);
				persistPlanState(pi);
				paintPlanStatus(ctx);
				return {
					action: "transform" as const,
					text: planPromptText(match),
					images: event.images,
				};
			}
			planMode = false;
			exitPlanMode(pi);
			persistPlanState(pi);
			paintPlanStatus(ctx);
			return {
				action: "transform" as const,
				text: offPromptText(match),
				images: event.images,
			};
		} catch (err) {
			// Fail OPEN here, unlike the tool gate: the worst case of passing the
			// prompt through unchanged is that the literal `/plan` reaches the model,
			// which is visible and harmless. Swallowing the user's turn is not.
			log(
				`input hook failed (${errorText(err)}); prompt passed through unchanged.`
			);
			return;
		}
	});

	/**
	 * THE GATE. Ordering is the whole reason plan mode and permissions share this
	 * file, and it is:
	 *
	 *     1. plan-mode denial   — the mode the user explicitly asked for wins
	 *     2. local hard deny    — irreversible, no prompt can make it safe
	 *     3. gateway exec scan  — the node's own command policy, via Core
	 *     4. policy confirm     — legitimate but destructive, ask the human
	 *
	 * Steps 2 and 3 are both refusals, and the LOCAL one runs first on purpose:
	 * it needs no network, so a command nothing could make safe is refused even
	 * when Core is unreachable. Step 3 can only ever tighten the answer — it
	 * denies, or it raises step 4's prompt for a command the local list did not
	 * know about.
	 *
	 * IT MUST NOT THROW. Pi's `emitToolCall` has no try/catch of its own (unlike
	 * `emitUserBash`), so an escaping exception is reported as an extension error
	 * against a tool call in unknown state. The whole body is wrapped and fails
	 * SAFE — a guard that cannot evaluate a call blocks it.
	 */
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		try {
			if (planMode && PLAN_DENY_TOOLS.has(event.toolName)) {
				return { block: true, reason: PLAN_BLOCK_REASON };
			}
			const denied = hardDeny(event.toolName, event.input);
			if (denied) {
				log(`hard-denied ${event.toolName}.`);
				return { block: true, reason: denied };
			}
			let ask = needsConfirm(event.toolName, event.input);
			// Gateway governance for shell commands, between the local hard denies
			// and the local confirm list. It runs for a subagent child too — a child
			// cannot answer a prompt, but a `deny` needs no answer, and the child's
			// shell is exactly as unsupervised as the parent's.
			const command = COMMAND_TOOLS.has(event.toolName)
				? stringField(event.input, "command")
				: "";
			if (command) {
				const verdict = await scanExecCommand(command);
				if (verdict?.decision === "deny") {
					log(`gateway exec scan denied ${event.toolName}.`);
					return {
						block: true,
						reason: `Refused by Ryu's command policy: ${verdict.reason ?? "this command is not allowed on this node"}.`,
					};
				}
				if (verdict?.decision === "approval_required" && !ask) {
					// Escalate to the same confirm the local list would have raised, so
					// there is exactly one prompt shape for the user to learn.
					ask = { title: `run \`${commandHead(command)}\`` };
				}
			}
			if (!ask) {
				return;
			}
			if (IS_SUBAGENT) {
				// A `--mode json -p` child has no user. Failing closed here would block
				// EVERY tool in EVERY subagent; children are scoped with `--tools`
				// instead, and the hard denials above still applied.
				log(`subagent: skipping confirmation for ${event.toolName}.`);
				return;
			}
			if (!uiAvailable(ctx)) {
				// Headless with no dialog channel: allow, having already applied the
				// hard denials. Blocking would strand every unattended turn.
				log(
					`no UI to confirm ${event.toolName}; allowing after hard-deny check.`
				);
				return;
			}
			// Fails closed by construction: any ACP transport failure lands in
			// pi-acp's `requestExtensionPermission` catch, which answers
			// `{ cancelled: true }`, so this resolves false and we block.
			const ok = await ctx.ui.confirm(ask.title, "");
			if (!ok) {
				log(`user declined ${event.toolName}.`);
				return { block: true, reason: USER_DENIED_REASON };
			}
			return;
		} catch (err) {
			log(`guard failed for ${event.toolName} (${errorText(err)}); blocking.`);
			return { block: true, reason: GUARD_ERROR_REASON };
		}
	});

	/**
	 * Rehydrate the plan flag after a reload or a pool respawn. Best-effort by
	 * design: if it misses, plan mode falls off and the user retypes `/plan`,
	 * which is a far better failure than a session that thinks it is planning
	 * when the tool set says otherwise. Logged either way so the miss is visible.
	 */
	pi.on("session_start", (_event, ctx) => {
		try {
			const restored = readPersistedPlanState(ctx);
			if (restored === undefined) {
				log("session_start: no persisted plan state; plan mode is off.");
				return;
			}
			planMode = restored;
			if (restored) {
				enterPlanMode(pi);
			}
			log(`session_start: plan mode rehydrated ${restored ? "ON" : "OFF"}.`);
			paintPlanStatus(ctx);
		} catch (err) {
			log(`session_start rehydrate failed (${errorText(err)}).`);
		}
	});
}
