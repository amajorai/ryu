import {
	readToolTiming,
	type ToolTimingSource,
} from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { nonEmptyString } from "./cowork-source-tools.ts";
import {
	readToolPayload,
	type StreamMessage,
	type StreamPart,
} from "./cowork-types.ts";

// ── Subagents (Task/Agent tool spawns) ─────────────────────────────────────────

// A run spawns a subagent via the `Task`/`Agent` tool (Claude Code / ACP). Each
// spawn is a tool part in the stream, and the tools the subagent itself ran are
// nested tool parts whose `toolCallId` is prefixed `<parentTaskId>:` — the same
// scheme the message list uses to fold nested rows under a subagent (see
// packages/blocks/.../message-list.tsx). We reconstruct each subagent's chat
// (prompt → its tool steps → its result) from those parts so it can be reopened
// in the right panel, with no extra endpoint.

const SUBAGENT_PART_TYPES = new Set(["tool-Task", "tool-Agent"]);
const TOOL_PREFIX_RE = /^tool-/;
const WHITESPACE_RE = /\s+/g;
const TASK_TITLE_MAX_CHARS = 60;
const SENTENCE_END_RE = /[.!?](?:\s|$)/;

export interface SubagentSummary {
	/**
	 * A live one-line description of what the subagent is doing right now (its
	 * latest tool step). Empty once done. Recomputed on every stream tick so the
	 * panel row updates live instead of only at the end.
	 */
	activity: string;
	/** Lines added/removed by this subagent's nested write tools. */
	changes: { deletions: number; insertions: number };
	/**
	 * The spawn ended in `output-error`. Distinct from a merely empty result: an
	 * errored Task usually carries no extractable output text either, so without
	 * this a failure and a clean silent finish are indistinguishable downstream —
	 * and the panel would tell the user a failed task "finished".
	 */
	errored: boolean;
	/** The Task/Agent tool call id — stable key + the transcript's identity. */
	id: string;
	/**
	 * The subagent kind (`subagent_type`), e.g. "code-reviewer". EMPTY when the
	 * spawn declared no type — which is every Claude-Code/Codex `Task` that omits
	 * it, and every `tool-Agent` spawn. Display-only, and every consumer must
	 * guard it: it used to default to the literal "Agent", which under a section
	 * already titled "Subagents" printed "Atlas Agent" and said nothing.
	 */
	label: string;
	status: "running" | "done";
	/**
	 * How many tool steps of the subagent's own we could reconstruct. ZERO is the
	 * common case, not an error: child steps exist only where the agent emits the
	 * `details.ryuSteps` marker (today, the managed Pi agent), so a Claude-Code or
	 * Codex subagent over ACP reports none. Consumers use this to tell "nothing to
	 * show yet" apart from "this agent never narrates its steps".
	 */
	steps: number;
	/** The one-line task description, if any. */
	subtitle: string;
	/** The Core-stamped start/completion time for this Task tool call. */
	timing: ToolTimingSource | null;
	/** Human-facing task name, derived from the spawn's description or prompt. */
	title: string;
	/** A reconstructed read-only transcript for the right panel's MessageList. */
	transcript: UIMessage[];
}

/**
 * Name a subagent after the work it owns. Task-capable agents already author a
 * short `description`; older or foreign ACP producers may omit it, so the first
 * sentence of the prompt is the deterministic fallback. An opaque call id must
 * never leak into the label and we never invent a persona name.
 */
export function subagentTaskTitle({
	description,
	prompt,
}: {
	description?: unknown;
	prompt?: unknown;
}): string {
	const described = nonEmptyString(description)?.trim();
	const prompted = nonEmptyString(prompt)?.trim();
	const source = described || prompted;
	if (!source) {
		return "Subagent task";
	}
	const firstLine = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) {
		return "Subagent task";
	}
	const flattened = firstLine.replace(WHITESPACE_RE, " ");
	const sentenceEnd = flattened.search(SENTENCE_END_RE);
	const specific = (
		sentenceEnd === -1 ? flattened : flattened.slice(0, sentenceEnd + 1)
	).replace(/[.!?]+$/, "");
	const characters = [...specific];
	return characters.length <= TASK_TITLE_MAX_CHARS
		? specific
		: `${characters
				.slice(0, TASK_TITLE_MAX_CHARS - 1)
				.join("")
				.trimEnd()}…`;
}

/** Best-effort text extraction from a tool part's loose input/output shapes. */
function partText<TValue>(value: TValue): string {
	if (value == null) {
		return "";
	}
	if (isNativeText(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(partText).filter(Boolean).join("\n");
	}
	const obj = readToolPayload(value);
	if (obj) {
		if (isNativeText(obj.text)) {
			return obj.text;
		}
		if (obj.content !== undefined) {
			return partText(obj.content);
		}
		if (obj.output !== undefined) {
			return partText(obj.output);
		}
		if (isNativeText(obj.result)) {
			return obj.result;
		}
	}
	return "";
}

/** Drop the `<parentTaskId>:` prefix so a nested tool renders as a top-level row. */
function stripParentPrefix(part: StreamPart): StreamPart {
	const id = part.toolCallId;
	if (isNativeText(id) && id.includes(":")) {
		return { ...part, toolCallId: id.slice(id.indexOf(":") + 1) };
	}
	return part;
}

interface SubagentParts {
	/** The subagent's own tool calls, prefix-stripped and stream-ordered. */
	nested: Map<string, StreamPart[]>;
	/** The subagent's final answer text, concatenated from `tool-TaskOutput`. */
	output: Map<string, string>;
}

/** Split the stream's parts into per-subagent tool steps and output text. */
function groupSubagentParts(
	allParts: StreamPart[],
	taskIds: Set<string>
): SubagentParts {
	const nested = new Map<string, StreamPart[]>();
	const output = new Map<string, string>();
	for (const part of allParts) {
		const id = part.toolCallId;
		if (!(isNativeText(id) && id.includes(":"))) {
			continue;
		}
		const parent = id.slice(0, id.indexOf(":"));
		if (!taskIds.has(parent)) {
			continue;
		}
		// `tool-TaskOutput` carries the subagent's final answer, not a tool step.
		if (part.type === "tool-TaskOutput") {
			const text = partText(part.output ?? part.input);
			if (text) {
				output.set(parent, (output.get(parent) ?? "") + text);
			}
			continue;
		}
		const list = nested.get(parent);
		if (list) {
			list.push(part);
		} else {
			nested.set(parent, [part]);
		}
	}
	return { nested, output };
}

/** Shorten a detail string for a single compact activity line. */
function shortenDetail(value: string): string {
	const trimmed = value.replace(WHITESPACE_RE, " ").trim();
	return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

/** A live one-line label for the subagent's most recent tool step. */
function latestActivity(nested: StreamPart[]): string {
	if (nested.length === 0) {
		return "Starting…";
	}
	const last = nested.at(-1);
	if (!last) {
		return "Working…";
	}
	const name = isNativeText(last.type)
		? last.type.replace(TOOL_PREFIX_RE, "")
		: "tool";
	const input = readToolPayload(last.input);
	const detail =
		input?.file_path ??
		input?.command ??
		input?.pattern ??
		input?.query ??
		input?.path ??
		input?.description;
	const detailStr =
		isNativeText(detail) && detail ? ` ${shortenDetail(detail)}` : "";
	return `${name}${detailStr}`;
}

function lineCount<TValue>(value: TValue): number {
	return isNativeText(value) && value.length > 0 ? value.split("\n").length : 0;
}

/** Best-effort per-agent diff stats from the same tool payloads used for activity. */
function nestedChanges(nested: StreamPart[]) {
	let insertions = 0;
	let deletions = 0;
	for (const part of nested) {
		const input = readToolPayload(part.input) ?? {};
		const output = readToolPayload(part.output) ?? {};
		const diffStats = isNativeText(output.diffStats) ? output.diffStats : "";
		const added = /\+(\d+)/.exec(diffStats)?.[1];
		const removed = /-(\d+)/.exec(diffStats)?.[1];
		if (added || removed) {
			insertions += Number(added ?? 0);
			deletions += Number(removed ?? 0);
			continue;
		}
		const patch = isNativeText(input.patch) ? input.patch : "";
		if (patch) {
			for (const line of patch.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) {
					insertions += 1;
				}
				if (line.startsWith("-") && !line.startsWith("---")) {
					deletions += 1;
				}
			}
			continue;
		}
		insertions += lineCount(input.new_string ?? input.new_str ?? input.content);
		deletions += lineCount(input.old_string ?? input.old_str);
	}
	return { insertions, deletions };
}

/** Reconstruct one subagent's summary + read-only transcript from its parts. */
function toSubagentSummary(
	task: StreamPart,
	grouped: SubagentParts
): SubagentSummary {
	const id = task.toolCallId;
	if (!id) {
		throw new Error("Subagent task requires a tool call id");
	}
	const input = readToolPayload(task.input);
	const subtitle = nonEmptyString(input?.description)?.trim() ?? "";
	const taskPrompt = nonEmptyString(input?.prompt)?.trim() ?? "";
	const status: SubagentSummary["status"] =
		task.state === "output-available" || task.state === "output-error"
			? "done"
			: "running";
	const title = subagentTaskTitle({
		description: subtitle,
		prompt: taskPrompt,
	});
	const prompt = taskPrompt || subtitle || "Subagent task";
	const nested = (grouped.nested.get(id) ?? []).map(stripParentPrefix);
	const activity = status === "running" ? latestActivity(nested) : "";
	const outputText = grouped.output.get(id) || partText(task.output);

	const assistantParts: unknown[] = [...nested];
	if (outputText) {
		assistantParts.push({ type: "text", text: outputText });
	}
	const transcript =
		/* SAFETY: These literal transcript messages own string ids and user/assistant roles; nested entries retain the original SDK tool parts grouped by checked task id. */ [
			{
				id: `${id}:prompt`,
				role: "user",
				parts: [{ type: "text", text: prompt }],
			},
			{ id: `${id}:result`, role: "assistant", parts: assistantParts },
		] as UIMessage[];

	return {
		changes: nestedChanges(nested),
		id,
		label: nonEmptyString(input?.subagent_type)?.trim() ?? "",
		subtitle,
		status,
		errored: task.state === "output-error",
		activity,
		steps: nested.length,
		timing: readToolTiming(task),
		title,
		transcript,
	};
}

/** Subagents spawned by the run, newest-relevant order preserved (stream order). */
export function extractSubagents(messages: StreamMessage[]): SubagentSummary[] {
	const allParts: StreamPart[] = [];
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			allParts.push(part);
		}
	}

	const tasks = allParts.filter(
		(p) =>
			isNativeText(p.type) &&
			SUBAGENT_PART_TYPES.has(p.type) &&
			isNativeText(p.toolCallId)
	);
	if (tasks.length === 0) {
		return [];
	}

	const taskIds = new Set(
		tasks.flatMap((task) => (task.toolCallId ? [task.toolCallId] : []))
	);
	const grouped = groupSubagentParts(allParts, taskIds);
	return tasks.map((task) => toSubagentSummary(task, grouped));
}
