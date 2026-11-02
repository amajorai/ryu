import { tf, tr } from "../i18n/translate.ts";
import {
	asRecord,
	type ChatTodo,
	type ChatToolArguments,
	type ChatToolResult,
} from "./chatTranscript.ts";
import {
	type BoundedTerminalText,
	boundTerminalText,
	clampTerminalLine,
	sanitizeTerminalText,
} from "./transcriptTerminalText.ts";
import {
	findDiffText,
	isDiffTool,
	TRANSCRIPT_LIMITS,
	type TranscriptJsonValue,
	transcriptEntries,
	transcriptScalarSchema,
	transcriptTextSchema,
} from "./transcriptValues.ts";

export {
	type BoundedTerminalText,
	type BoundTerminalTextOptions,
	boundTerminalText,
	sanitizeTerminalText,
} from "./transcriptTerminalText.ts";
export {
	formatReasoningDuration,
	formatToolDuration,
	toolActivityLabel,
	toolDiffStat,
	toolDurationMs,
	toolPendingLabel,
	toolSummary,
} from "./transcriptToolPresentation.ts";
export { isDiffTool, TRANSCRIPT_LIMITS } from "./transcriptValues.ts";
/** Plain-text lines a user turn shows before it collapses behind a hint. */
export const USER_TURN_COLLAPSED_LINES = 6;

/**
 * Collapse a long user prompt to its first `maxLines` plain-text lines. The
 * caller renders `hiddenLines` as a "… N more lines" hint when it is non-zero.
 */
export function collapseUserTurnText(
	text: string,
	maxLines: number = USER_TURN_COLLAPSED_LINES
): { hiddenLines: number; text: string } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) {
		return { hiddenLines: 0, text };
	}
	return {
		hiddenLines: lines.length - maxLines,
		text: lines.slice(0, maxLines).join("\n"),
	};
}

export type TodoStatusKind = "pending" | "in_progress" | "completed" | "error";

export type TodoStatusTone = "muted" | "primary" | "success" | "error";

export interface TodoStatusPresentation {
	icon: string;
	kind: TodoStatusKind;
	label: string;
	tone: TodoStatusTone;
}

const stringifyTerminalValue = (value: ChatToolResult): string => {
	const text = transcriptTextSchema.safeParse(value);
	if (text.success) {
		return text.data;
	}
	if (value === undefined) {
		return "";
	}
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
};

const MAX_OUTPUT_DEPTH = 4;
const MAX_OUTPUT_ENTRIES = 32;

const moreItems = (count: number): string =>
	tf("[{count, plural, one {# more item} other {# more items}}]", { count });

const moreFields = (count: number): string =>
	tf("[{count, plural, one {# more field} other {# more fields}}]", { count });

const presentOutputValue = (
	value: ChatToolResult,
	depth: number
): TranscriptJsonValue => {
	const text = transcriptTextSchema.safeParse(value);
	if (text.success) {
		return boundTerminalText(text.data, {
			label: "tool output",
			maxChars: TRANSCRIPT_LIMITS.toolOutputChars,
			maxLines: TRANSCRIPT_LIMITS.toolOutputLines,
		}).text;
	}
	const scalar = transcriptScalarSchema.safeParse(value);
	if (scalar.success) {
		return scalar.data;
	}
	if (depth >= MAX_OUTPUT_DEPTH) {
		return tr("[tool output depth truncated]");
	}
	if (Array.isArray(value)) {
		const values = value
			.slice(0, MAX_OUTPUT_ENTRIES)
			.map((item) => presentOutputValue(item, depth + 1));
		if (value.length > MAX_OUTPUT_ENTRIES) {
			values.push(moreItems(value.length - MAX_OUTPUT_ENTRIES));
		}
		return values;
	}
	if (value !== undefined) {
		const entries = transcriptEntries(value);
		const output: ChatToolArguments = {};
		for (const [key, item] of entries.slice(0, MAX_OUTPUT_ENTRIES)) {
			output[sanitizeTerminalText(key).slice(0, 120)] = presentOutputValue(
				item,
				depth + 1
			);
		}
		if (entries.length > MAX_OUTPUT_ENTRIES) {
			output.__truncated__ = moreFields(entries.length - MAX_OUTPUT_ENTRIES);
		}
		return output;
	}
	return sanitizeTerminalText(String(value));
};

export const presentToolOutput = (
	value: ChatToolResult
): BoundedTerminalText | undefined => {
	if (value === undefined) {
		return undefined;
	}
	return boundTerminalText(
		stringifyTerminalValue(presentOutputValue(value, 0)),
		{
			label: "tool output",
			maxChars: TRANSCRIPT_LIMITS.toolOutputChars,
			maxLines: TRANSCRIPT_LIMITS.toolOutputLines,
		}
	);
};

export const formatToolOutput = (value: ChatToolResult): string | undefined =>
	presentToolOutput(value)?.text;

const MAX_ARGUMENT_DEPTH = 4;
const MAX_ARGUMENT_ENTRIES = 32;

const presentArgumentValue = (
	value: ChatToolResult,
	depth: number
): TranscriptJsonValue => {
	const text = transcriptTextSchema.safeParse(value);
	if (text.success) {
		return boundTerminalText(text.data, {
			label: "argument",
			maxChars: TRANSCRIPT_LIMITS.toolArgumentChars,
			maxLines: TRANSCRIPT_LIMITS.toolArgumentLines,
		}).text;
	}
	const scalar = transcriptScalarSchema.safeParse(value);
	if (scalar.success) {
		return scalar.data;
	}
	if (depth >= MAX_ARGUMENT_DEPTH) {
		return tr("[argument depth truncated]");
	}
	if (Array.isArray(value)) {
		const values = value
			.slice(0, MAX_ARGUMENT_ENTRIES)
			.map((item) => presentArgumentValue(item, depth + 1));
		if (value.length > MAX_ARGUMENT_ENTRIES) {
			values.push(moreItems(value.length - MAX_ARGUMENT_ENTRIES));
		}
		return values;
	}
	if (value !== undefined) {
		const entries = transcriptEntries(value);
		const output: ChatToolArguments = {};
		for (const [key, item] of entries.slice(0, MAX_ARGUMENT_ENTRIES)) {
			const safeKey = sanitizeTerminalText(key).slice(0, 120);
			output[safeKey] = presentArgumentValue(item, depth + 1);
		}
		if (entries.length > MAX_ARGUMENT_ENTRIES) {
			output.__truncated__ = moreFields(entries.length - MAX_ARGUMENT_ENTRIES);
		}
		return output;
	}
	return sanitizeTerminalText(String(value));
};

export const boundToolArguments = (
	args: ChatToolArguments | undefined
): ChatToolArguments | undefined => {
	if (!args) {
		return undefined;
	}
	const bounded = presentArgumentValue(args, 0);
	return asRecord(bounded);
};

/** Add a result-supplied patch to the args shape consumed by the existing Diff primitive. */
export const toolArgumentsForPresentation = (
	name: string,
	args: ChatToolArguments | undefined,
	result: ChatToolResult
): ChatToolArguments | undefined => {
	const boundedArgs = boundToolArguments(args);
	if (!isDiffTool(name)) {
		return boundedArgs;
	}
	const diffText = findDiffText(result);
	const nestedArgs = asRecord(boundedArgs?.rawInput);
	const hasDiffInput =
		boundedArgs?.patch ||
		boundedArgs?.diff ||
		(nestedArgs && (nestedArgs.patch || nestedArgs.diff));
	if (!diffText || hasDiffInput) {
		return boundedArgs;
	}
	if (boundedArgs && nestedArgs) {
		return boundToolArguments({
			...boundedArgs,
			rawInput: { ...nestedArgs, patch: diffText },
		});
	}
	return boundToolArguments({ ...boundedArgs, patch: diffText });
};

export const todoStatusPresentation = (
	status: string,
	unicode = true
): TodoStatusPresentation => {
	const normalized = status
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (["completed", "complete", "done"].includes(normalized)) {
		return {
			kind: "completed",
			icon: unicode ? "✓" : "[x]",
			label: "completed",
			tone: "success",
		};
	}
	if (["in_progress", "running", "active"].includes(normalized)) {
		return {
			kind: "in_progress",
			icon: unicode ? "•" : "[>]",
			label: "in progress",
			tone: "primary",
		};
	}
	if (["error", "failed", "blocked"].includes(normalized)) {
		return {
			kind: "error",
			icon: unicode ? "✗" : "[!]",
			label: normalized,
			tone: "error",
		};
	}
	return {
		kind: "pending",
		icon: unicode ? "○" : "[ ]",
		label: normalized || "pending",
		tone: "muted",
	};
};

export const completedTodoCount = (todos: Pick<ChatTodo, "status">[]): number =>
	todos.filter(
		(todo) => todoStatusPresentation(todo.status).kind === "completed"
	).length;

/** Character budget for a collapsed reasoning row's title. */
export const REASONING_TITLE_CHARS = 60;

const leadingBoldTitle = /^\*\*([^*\n]+?)\*\*/;

/**
 * Title for a collapsed reasoning row: the leading `**bold**` heading many
 * reasoning models emit, else the first non-empty line, kept to one row.
 */
export const reasoningTitle = (
	text: string,
	maxChars: number = REASONING_TITLE_CHARS
): string => {
	const sanitized = sanitizeTerminalText(text).trimStart();
	const bold = leadingBoldTitle.exec(sanitized)?.[1];
	const firstLine =
		bold ?? sanitized.split("\n").find((line) => line.trim().length > 0) ?? "";
	return clampTerminalLine(firstLine, maxChars);
};
