// apps/desktop/src/lib/mission-control/turn-groups.ts
//
// Turns a conversation's message stream into the "what did this chat actually
// DO" digest that Mission Control renders — one card per TURN (a user request
// plus every assistant/tool message that answers it), the way a stacked-PR tool
// summarises a diff into logical changes rather than a wall of commits.
//
// Everything here is PURE and derives from `messages[].parts` alone, which is
// the substrate Core already persists: `PartsAccumulator`
// (`apps/core/src/sidecar/adapters/mod.rs`) captures every tool call's name,
// `toolCallId`, full `input`, full `output` and terminal state into the sealed
// `parts` column, interleaved with the assistant's text in stream order. So the
// digest is identical for a live stream and for a chat reloaded from disk, and
// needs no model call, no sidecar and no new Core surface to exist.
//
// The RATIONALE is deliberately the assistant's own words, not a generated
// paraphrase: the prose it wrote before touching anything is why it did what it
// did, and the closing prose is what it thinks happened. Summarising those with
// a second model would launder the one honest signal in the transcript.

import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import type { DynamicToolUIPart } from "ai";
import { z } from "zod";

/** A message part, typed loosely — we read the AI SDK fields we care about and
 *  ignore the rest, exactly as `CoworkContextPanel` does. */
export interface MissionStreamPart {
	input?: unknown;
	output?: unknown;
	/** Tool parts only: `input-available` until the result frame patches it. */
	state?: string;
	text?: unknown;
	toolCallId?: string;
	/** Present on `dynamic-tool` parts, where the name isn't in `type`. */
	toolName?: string;
	type?: string;
}

export interface MissionStreamMessage {
	id?: string;
	parts?: MissionStreamPart[];
	role?: string;
}

/** How a turn touched one path. `create` and `edit` are writes; `read` is not. */
export type MissionTouchKind = "create" | "edit" | "read";

export interface MissionFileTouch {
	/** Number of tool calls in scope that touched this path. */
	count: number;
	kind: MissionTouchKind;
	path: string;
}

export interface MissionCommand {
	command: string;
	description?: string;
	failed: boolean;
}

export interface MissionToolStat {
	calls: number;
	failures: number;
	name: string;
}

export interface MissionTodo {
	content: string;
	status: "completed" | "in_progress" | "pending";
}

/** A turn that is still streaming has tool calls with no result frame yet. */
export type MissionTurnStatus = "failed" | "ok" | "running";

export interface MissionTurn {
	/** Sub-agents this turn spawned, by their task description. */
	delegates: string[];
	files: MissionFileTouch[];
	/** Deterministic one-liner naming the work, e.g. "Edited 3 files, ran 2 commands". */
	headline: string;
	/** Stable id: the first message in the turn. */
	id: string;
	/** 1-based position in the conversation. */
	index: number;
	messageIds: string[];
	/** The assistant's closing prose — what it says it accomplished. */
	outcome: string;
	/** The assistant's prose before it touched anything — why it did this. */
	rationale: string;
	/** The user's ask, trimmed to a readable length. */
	request: string;
	searches: string[];
	shellCommands: MissionCommand[];
	status: MissionTurnStatus;
	/** Extended-thinking text, when the agent emitted reasoning parts. */
	thinking: string;
	/** The plan snapshot this turn wrote, if it wrote one. */
	todos: MissionTodo[];
	tools: MissionToolStat[];
	web: string[];
}

export interface MissionTotals {
	commands: number;
	failures: number;
	filesTouched: number;
	toolCalls: number;
	turns: number;
	writes: number;
}

export interface MissionDigest {
	/** Latest plan snapshot, split by whether the work is still outstanding. */
	doneTodos: MissionTodo[];
	/** Every path the conversation wrote or read, rolled up across turns. */
	files: MissionFileTouch[];
	openTodos: MissionTodo[];
	totals: MissionTotals;
	turns: MissionTurn[];
}

// ── Text limits ───────────────────────────────────────────────────────────────
// Card copy, not storage: the panel shows a readable excerpt and the full text
// stays one click away in the transcript itself.
const MAX_REQUEST_CHARS = 240;
const MAX_RATIONALE_CHARS = 600;
const MAX_OUTCOME_CHARS = 600;
const MAX_THINKING_CHARS = 600;
const MAX_HEADLINE_PATHS = 2;

const TOOL_PART_PREFIX = "tool-";
const DYNAMIC_TOOL_PART = "dynamic-tool";
const PLAN_TOOL = "TodoWrite";

/** Tools whose call means a file came into existence. */
const CREATE_TOOLS = new Set(["Write", "create_file"]);
/** Tools whose call means an existing file changed. */
const EDIT_TOOLS = new Set([
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"apply_patch",
	"str_replace_editor",
]);
/** Tools that only look at a file. */
const READ_TOOLS = new Set(["Read", "NotebookRead", "view_file"]);
const SHELL_TOOLS = new Set([
	"Bash",
	"BashOutput",
	"run_terminal_cmd",
	"shell",
]);
const SEARCH_TOOLS = new Set([
	"Grep",
	"Glob",
	"codebase_search",
	"file_search",
]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "web_search"]);
const DELEGATE_TOOLS = new Set(["Task", "Agent", "Workflow"]);

/** Input keys that name a file, in the order tools tend to use them. Exported
 *  so the Cowork rail's Sources list reads paths out of the same field names
 *  rather than growing a second, drifting guess at the tool schemas. */
export const PATH_KEYS = [
	"file_path",
	"filePath",
	"notebook_path",
	"path",
	"target",
];

// ── Small readers over untyped tool input ─────────────────────────────────────

/** These are native live SDK input observations, not decoded persistence DTOs.
 * Only object representation and each consumed string slot are admitted at the
 * original read stage; unrelated opaque metadata remains untouched. */
export type MissionRawInput = DynamicToolUIPart["input"];
const missionTextSchema = z.string();
const missionCallableSchema = z.function();
interface NativeMissionToolLookup {
	readonly [key: string]: DynamicToolUIPart["input"];
}
function nativeMissionRecord(
	value: MissionRawInput
): NativeMissionToolLookup | undefined {
	const receiver = new Object(value);
	if (
		receiver !== value ||
		value === null ||
		nativeSdkSchemaAdmits(missionCallableSchema, value) ||
		Array.isArray(value)
	) {
		return;
	}
	// SAFETY: This is an erased native lookup view after the original object-only
	// representation guard. Slots remain the opaque AI SDK input domain; it claims
	// no full tool DTO or JSON values and performs no field enumeration/validation.
	return value as NativeMissionToolLookup;
}
function readString(source: MissionRawInput, key: string): string | undefined {
	const record = nativeMissionRecord(source);
	const value = record?.[key];
	if (!nativeSdkSchemaAdmits(missionTextSchema, value)) {
		return;
	}
	// SAFETY: Cached scalar admission establishes this exact observed primitive
	// string without user callbacks or formatting; original trim operation remains.
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
export function firstString(
	source: MissionRawInput,
	keys: string[]
): string | undefined {
	for (const key of keys) {
		const found = readString(source, key);
		if (found !== undefined) {
			return found;
		}
	}
	return;
}

function partText(part: MissionStreamPart): string {
	const parsed = z.string().safeParse(part.text);
	return parsed.success ? parsed.data.trim() : "";
}

function clamp(text: string, max: number): string {
	const collapsed = text.trim();
	if (collapsed.length <= max) {
		return collapsed;
	}
	return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** The last path segment, for headlines that shouldn't show a whole repo path. */
function baseName(path: string): string {
	const parts = path.split("/").filter((segment) => segment.length > 0);
	return parts.at(-1) ?? path;
}

// ── Part classification ───────────────────────────────────────────────────────

export function isToolPart(part: MissionStreamPart): boolean {
	const type = z.string().safeParse(part.type);
	return (
		part.type === DYNAMIC_TOOL_PART ||
		(type.success && type.data.startsWith(TOOL_PART_PREFIX))
	);
}

/** The tool's name, whether it arrived as `tool-<Name>` or a dynamic part. */
export function toolNameOf(part: MissionStreamPart): string {
	if (part.type === DYNAMIC_TOOL_PART) {
		const name = z.string().min(1).safeParse(part.toolName);
		return name.success ? name.data : "tool";
	}
	const type = z.string().safeParse(part.type);
	if (type.success && type.data.startsWith(TOOL_PART_PREFIX)) {
		return type.data.slice(TOOL_PART_PREFIX.length) || "tool";
	}
	return "tool";
}

function isFailure(part: MissionStreamPart): boolean {
	return part.state === "output-error";
}

/** A tool call with no terminal frame yet — the turn is still working. */
function isPending(part: MissionStreamPart): boolean {
	return part.state !== "output-error" && part.state !== "output-available";
}

function touchKindFor(tool: string): MissionTouchKind | undefined {
	if (CREATE_TOOLS.has(tool)) {
		return "create";
	}
	if (EDIT_TOOLS.has(tool)) {
		return "edit";
	}
	if (READ_TOOLS.has(tool)) {
		return "read";
	}
	return;
}

function readTodos(input: MissionRawInput): MissionTodo[] {
	const record = nativeMissionRecord(input);
	const raw = record?.todos;
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: MissionTodo[] = [];
	for (const entry of raw) {
		const content = readString(entry, "content");
		if (content === undefined) {
			continue;
		}
		const status = readString(entry, "status");
		out.push({
			content,
			status:
				status === "completed" || status === "in_progress" ? status : "pending",
		});
	}
	return out;
}

// ── Accumulating one turn's tool activity ─────────────────────────────────────

/** A write beats a read for the same path: seeing a file then editing it is an
 *  edit, and showing both rows would double-count the same work. */
const TOUCH_RANK = {
	read: 0,
	edit: 1,
	create: 2,
} satisfies Record<MissionTouchKind, number>;

class TouchLedger {
	private readonly byPath = new Map<string, MissionFileTouch>();

	add(path: string, kind: MissionTouchKind) {
		const existing = this.byPath.get(path);
		if (!existing) {
			this.byPath.set(path, { path, kind, count: 1 });
			return;
		}
		existing.count += 1;
		if (TOUCH_RANK[kind] > TOUCH_RANK[existing.kind]) {
			existing.kind = kind;
		}
	}

	merge(touches: MissionFileTouch[]) {
		for (const touch of touches) {
			const existing = this.byPath.get(touch.path);
			if (!existing) {
				this.byPath.set(touch.path, { ...touch });
				continue;
			}
			existing.count += touch.count;
			if (TOUCH_RANK[touch.kind] > TOUCH_RANK[existing.kind]) {
				existing.kind = touch.kind;
			}
		}
	}

	/** Writes first (that's the interesting work), then by touch count, then path
	 *  — a total order, so the same digest always renders in the same order. */
	list(): MissionFileTouch[] {
		return [...this.byPath.values()].sort((a, b) => {
			const byKind = TOUCH_RANK[b.kind] - TOUCH_RANK[a.kind];
			if (byKind !== 0) {
				return byKind;
			}
			const byCount = b.count - a.count;
			return byCount === 0 ? a.path.localeCompare(b.path) : byCount;
		});
	}
}

interface TurnActivity {
	delegates: string[];
	files: TouchLedger;
	hasPending: boolean;
	searches: string[];
	shellCommands: MissionCommand[];
	todos: MissionTodo[];
	tools: Map<string, MissionToolStat>;
	web: string[];
}

function newActivity(): TurnActivity {
	return {
		delegates: [],
		files: new TouchLedger(),
		hasPending: false,
		searches: [],
		shellCommands: [],
		todos: [],
		tools: new Map(),
		web: [],
	};
}

function pushUnique(list: string[], value: string | undefined) {
	if (value !== undefined && !list.includes(value)) {
		list.push(value);
	}
}

/** Record the domain-specific detail a tool call carries, by family. */
function recordToolDetail(
	activity: TurnActivity,
	tool: string,
	part: MissionStreamPart
) {
	const touchKind = touchKindFor(tool);
	const path = firstString(part.input, PATH_KEYS);
	if (touchKind !== undefined && path !== undefined) {
		activity.files.add(path, touchKind);
		return;
	}
	if (SHELL_TOOLS.has(tool)) {
		const command = firstString(part.input, ["command", "cmd"]);
		if (command !== undefined) {
			activity.shellCommands.push({
				command,
				description: readString(part.input, "description"),
				failed: isFailure(part),
			});
		}
		return;
	}
	if (SEARCH_TOOLS.has(tool)) {
		pushUnique(
			activity.searches,
			firstString(part.input, ["pattern", "query"])
		);
		return;
	}
	if (WEB_TOOLS.has(tool)) {
		pushUnique(activity.web, firstString(part.input, ["url", "query"]));
		return;
	}
	if (DELEGATE_TOOLS.has(tool)) {
		pushUnique(
			activity.delegates,
			firstString(part.input, ["description", "subagent_type", "name"])
		);
		return;
	}
	if (tool === PLAN_TOOL) {
		const todos = readTodos(part.input);
		if (todos.length > 0) {
			activity.todos = todos;
		}
	}
}

function recordTool(activity: TurnActivity, part: MissionStreamPart) {
	const tool = toolNameOf(part);
	const stat = activity.tools.get(tool) ?? {
		name: tool,
		calls: 0,
		failures: 0,
	};
	stat.calls += 1;
	if (isFailure(part)) {
		stat.failures += 1;
	}
	activity.tools.set(tool, stat);
	if (isPending(part)) {
		activity.hasPending = true;
	}
	recordToolDetail(activity, tool, part);
}

// ── Headline ──────────────────────────────────────────────────────────────────

function describeFiles(files: MissionFileTouch[]): string | undefined {
	const writes = files.filter((f) => f.kind !== "read");
	if (writes.length === 0) {
		return files.length > 0 ? `Read ${files.length} files` : undefined;
	}
	const verb = writes.every((f) => f.kind === "create") ? "Created" : "Changed";
	if (writes.length <= MAX_HEADLINE_PATHS) {
		return `${verb} ${writes.map((f) => baseName(f.path)).join(", ")}`;
	}
	const shown = writes
		.slice(0, MAX_HEADLINE_PATHS)
		.map((f) => baseName(f.path))
		.join(", ");
	return `${verb} ${shown} +${writes.length - MAX_HEADLINE_PATHS} more`;
}

/** A deterministic title for the card. Prefers the concrete artefact the turn
 *  produced; falls back to the shape of the work, then to plain conversation. */
function buildHeadline(turn: Omit<MissionTurn, "headline">): string {
	const clauses: string[] = [];
	const fileClause = describeFiles(turn.files);
	if (fileClause !== undefined) {
		clauses.push(fileClause);
	}
	if (turn.shellCommands.length > 0) {
		const n = turn.shellCommands.length;
		clauses.push(`ran ${n} command${n === 1 ? "" : "s"}`);
	}
	if (turn.delegates.length > 0) {
		const n = turn.delegates.length;
		clauses.push(`delegated ${n} task${n === 1 ? "" : "s"}`);
	}
	if (clauses.length === 0 && turn.searches.length + turn.web.length > 0) {
		clauses.push("Investigated");
	}
	if (clauses.length === 0 && turn.todos.length > 0) {
		clauses.push("Planned the work");
	}
	if (clauses.length === 0) {
		return "Answered";
	}
	const [first, ...rest] = clauses;
	return rest.length === 0 ? first : `${first}, ${rest.join(", ")}`;
}

// ── Turn assembly ─────────────────────────────────────────────────────────────

interface TurnDraft {
	assistantIds: string[];
	parts: MissionStreamPart[];
	request: string;
	startId: string;
}

/** Split the stream into turns: a user message opens one, and every assistant
 *  message until the next user message belongs to it. Assistant output before
 *  any user message (a resumed or seeded thread) opens an unprompted turn. */
function splitTurns(messages: MissionStreamMessage[]): TurnDraft[] {
	const drafts: TurnDraft[] = [];
	let current: TurnDraft | undefined;
	for (const [i, message] of messages.entries()) {
		const id = message.id ?? `m${i}`;
		if (message.role === "user") {
			const text = (message.parts ?? [])
				.filter((p) => p.type === "text")
				.map(partText)
				.filter((t) => t.length > 0)
				.join("\n\n");
			current = { assistantIds: [], parts: [], request: text, startId: id };
			drafts.push(current);
			continue;
		}
		if (message.role !== "assistant") {
			continue;
		}
		if (!current) {
			current = { assistantIds: [], parts: [], request: "", startId: id };
			drafts.push(current);
		}
		current.assistantIds.push(id);
		current.parts.push(...(message.parts ?? []));
	}
	return drafts;
}

/** The assistant's prose, split at the first tool call: what it said it was
 *  about to do (the rationale) versus what it reported afterwards (the
 *  outcome). A turn with no tool calls is all outcome — it only answered. */
function splitProse(parts: MissionStreamPart[]) {
	const before: string[] = [];
	const after: string[] = [];
	const thinking: string[] = [];
	let seenTool = false;
	for (const part of parts) {
		if (isToolPart(part)) {
			seenTool = true;
			continue;
		}
		if (part.type === "reasoning") {
			const text = partText(part);
			if (text.length > 0) {
				thinking.push(text);
			}
			continue;
		}
		if (part.type !== "text") {
			continue;
		}
		const text = partText(part);
		if (text.length === 0) {
			continue;
		}
		if (seenTool) {
			after.push(text);
		} else {
			before.push(text);
		}
	}
	// No tool calls means nothing was "planned then done" — the prose is the answer.
	if (!seenTool) {
		return {
			outcome: before.join("\n\n"),
			rationale: "",
			thinking: thinking.join("\n\n"),
		};
	}
	return {
		outcome: after.join("\n\n"),
		rationale: before.join("\n\n"),
		thinking: thinking.join("\n\n"),
	};
}

function statusOf(activity: TurnActivity): MissionTurnStatus {
	if (activity.hasPending) {
		return "running";
	}
	for (const stat of activity.tools.values()) {
		if (stat.failures > 0) {
			return "failed";
		}
	}
	return "ok";
}

function buildTurn(draft: TurnDraft, index: number): MissionTurn {
	const activity = newActivity();
	for (const part of draft.parts) {
		if (isToolPart(part)) {
			recordTool(activity, part);
		}
	}
	const prose = splitProse(draft.parts);
	const base: Omit<MissionTurn, "headline"> = {
		delegates: activity.delegates,
		files: activity.files.list(),
		id: draft.startId,
		index,
		messageIds: [draft.startId, ...draft.assistantIds],
		outcome: clamp(prose.outcome, MAX_OUTCOME_CHARS),
		rationale: clamp(prose.rationale, MAX_RATIONALE_CHARS),
		request: clamp(draft.request, MAX_REQUEST_CHARS),
		searches: activity.searches,
		shellCommands: activity.shellCommands,
		status: statusOf(activity),
		thinking: clamp(prose.thinking, MAX_THINKING_CHARS),
		todos: activity.todos,
		tools: [...activity.tools.values()].sort((a, b) => b.calls - a.calls),
		web: activity.web,
	};
	return { ...base, headline: buildHeadline(base) };
}

/** True when the turn produced nothing worth its own card — an empty assistant
 *  message, or a user message the agent never answered. */
function isEmptyTurn(turn: MissionTurn): boolean {
	return (
		turn.tools.length === 0 &&
		turn.outcome.length === 0 &&
		turn.rationale.length === 0 &&
		turn.thinking.length === 0
	);
}

/**
 * The Mission Control digest for one conversation.
 *
 * Deterministic and side-effect free: same messages in, same digest out. The
 * dashboard indexes the result of this exact function, so a chat summarised in
 * the panel and the same chat summarised on the project page can never disagree.
 */
export function buildMissionDigest(
	messages: MissionStreamMessage[]
): MissionDigest {
	const turns: MissionTurn[] = [];
	for (const draft of splitTurns(messages)) {
		const turn = buildTurn(draft, turns.length + 1);
		if (isEmptyTurn(turn)) {
			continue;
		}
		turn.index = turns.length + 1;
		turns.push(turn);
	}

	const rollup = new TouchLedger();
	const totals: MissionTotals = {
		commands: 0,
		failures: 0,
		filesTouched: 0,
		toolCalls: 0,
		turns: turns.length,
		writes: 0,
	};
	for (const turn of turns) {
		rollup.merge(turn.files);
		totals.commands += turn.shellCommands.length;
		for (const stat of turn.tools) {
			totals.toolCalls += stat.calls;
			totals.failures += stat.failures;
		}
	}
	const files = rollup.list();
	totals.filesTouched = files.length;
	totals.writes = files.filter((f) => f.kind !== "read").length;

	// The newest plan snapshot wins: Core re-sends the whole list on every
	// TodoWrite, so an older snapshot is a strictly staler view of the same plan.
	const latestTodos =
		turns.filter((t) => t.todos.length > 0).at(-1)?.todos ?? [];

	return {
		doneTodos: latestTodos.filter((t) => t.status === "completed"),
		files,
		openTodos: latestTodos.filter((t) => t.status !== "completed"),
		totals,
		turns,
	};
}
