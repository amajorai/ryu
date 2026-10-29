import { z } from "zod";
import {
	asRecord,
	type ChatTodo,
	type ChatToolArguments,
	type ChatToolResult,
} from "./chatTranscript.ts";

type TranscriptJsonValue = Exclude<ChatToolResult, undefined>;
const transcriptTextSchema = z.string();
const transcriptScalarSchema = z.union([z.null(), z.boolean(), z.number()]);
// Values already passed the chat JSON boundary. These native adapters inspect only
// immediate entries/fields, leaving the presentation depth and entry limits in control.
function transcriptEntries(value: ChatToolResult): [string, ChatToolResult][] {
	return Object.entries(value ?? {});
}
function isTranscriptRecord(value: ChatToolResult): value is ChatToolArguments {
	return (
		value !== undefined &&
		!Array.isArray(value) &&
		!z.union([z.string(), z.null(), z.boolean(), z.number()]).safeParse(value)
			.success
	);
}
function transcriptField(value: ChatToolResult, key: string): ChatToolResult {
	return isTranscriptRecord(value) ? value[key] : undefined;
}

export const TRANSCRIPT_LIMITS = {
	markdownChars: 12_000,
	markdownLines: 240,
	thinkingChars: 8000,
	thinkingLines: 120,
	toolArgumentChars: 4000,
	toolArgumentLines: 80,
	toolOutputChars: 6000,
	toolOutputLines: 80,
	todoChars: 240,
	todoLines: 4,
	errorChars: 600,
	errorLines: 6,
	toolSummaryChars: 80,
} as const;

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

const TERMINAL_ESCAPE = String.fromCharCode(0x1b);
const TERMINAL_BELL = String.fromCharCode(0x07);

function stripAnsiSequences(value: string): string {
	let start = 0;
	let cursor = value.indexOf(TERMINAL_ESCAPE);
	const parts: string[] = [];
	while (cursor !== -1) {
		let end = -1;
		if (value[cursor + 1] === "]") {
			const bell = value.indexOf(TERMINAL_BELL, cursor + 2);
			if (bell === -1) {
				const closingEscape = value.lastIndexOf(`${TERMINAL_ESCAPE}\\`);
				if (closingEscape >= cursor + 2) {
					end = closingEscape + 2;
				}
			} else {
				end = bell + 1;
			}
		} else if (value[cursor + 1] === "[") {
			let final = cursor + 2;
			while (
				value.charCodeAt(final) >= 0x30 &&
				value.charCodeAt(final) <= 0x3f
			) {
				final++;
			}
			while (
				value.charCodeAt(final) >= 0x20 &&
				value.charCodeAt(final) <= 0x2f
			) {
				final++;
			}
			if (value.charCodeAt(final) >= 0x40 && value.charCodeAt(final) <= 0x7e) {
				end = final + 1;
			}
		}
		if (end === -1) {
			cursor++;
		} else {
			parts.push(value.slice(start, cursor));
			start = end;
			cursor = end;
		}
		cursor = value.indexOf(TERMINAL_ESCAPE, cursor);
	}
	parts.push(value.slice(start));
	return parts.join("");
}

function stripUnsafeTerminalCharacters(value: string): string {
	let output = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f)
		) {
			continue;
		}
		output += character;
	}
	return output;
}

export interface BoundedTerminalText {
	omittedChars: number;
	omittedLines: number;
	text: string;
	truncated: boolean;
}

export interface BoundTerminalTextOptions {
	label?: string;
	maxChars: number;
	maxLines?: number;
}

export type TodoStatusKind = "pending" | "in_progress" | "completed" | "error";

export type TodoStatusTone = "muted" | "primary" | "success" | "error";

export interface TodoStatusPresentation {
	icon: string;
	kind: TodoStatusKind;
	label: string;
	tone: TodoStatusTone;
}

/** Remove terminal control sequences before external text reaches an OpenTUI node. */
export const sanitizeTerminalText = (value: string): string =>
	stripUnsafeTerminalCharacters(
		stripAnsiSequences(value.replace(/\r\n?/g, "\n"))
	).replace(/\t/g, "  ");

const normalizedLimit = (value: number): number =>
	Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

const truncationMarker = (
	label: string,
	omittedChars: number,
	omittedLines: number
): string => {
	if (omittedLines > 0) {
		return `[${label} truncated: ${omittedLines} more ${omittedLines === 1 ? "line" : "lines"}]`;
	}
	return `[${label} truncated: ${omittedChars} more ${omittedChars === 1 ? "character" : "characters"}]`;
};

/** Bound both row count and character count while keeping a visible marker. */
export const boundTerminalText = (
	value: string,
	options: BoundTerminalTextOptions
): BoundedTerminalText => {
	const sanitized = sanitizeTerminalText(value);
	const maxChars = normalizedLimit(options.maxChars);
	const maxLines =
		options.maxLines === undefined
			? undefined
			: normalizedLimit(options.maxLines);
	const sourceLines = sanitized.split("\n");
	const lineLimited = maxLines !== undefined && sourceLines.length > maxLines;
	const initialLines = lineLimited
		? sourceLines.slice(0, maxLines)
		: sourceLines;
	const initialText = initialLines.join("\n");
	const charLimited = initialText.length > maxChars;

	if (!(lineLimited || charLimited)) {
		return {
			text: initialText,
			truncated: false,
			omittedChars: 0,
			omittedLines: 0,
		};
	}

	const omittedLines = lineLimited
		? sourceLines.length - initialLines.length
		: 0;
	const omittedChars = Math.max(0, sanitized.length - initialText.length);
	const label = sanitizeTerminalText(options.label ?? "text") || "text";
	const marker = truncationMarker(label, omittedChars, omittedLines);

	// Reserve the final line for the marker so maxLines remains a real terminal
	// bound rather than an approximate payload-only limit.
	const contentLines =
		maxLines === undefined
			? initialLines
			: initialLines.slice(0, Math.max(0, maxLines - 1));
	let content = contentLines.join("\n");
	const separatorLength = content.length > 0 ? 1 : 0;
	const markerText = marker.slice(0, maxChars);
	const contentBudget = Math.max(
		0,
		maxChars - separatorLength - markerText.length
	);
	content = content.slice(0, contentBudget);

	return {
		text: `${content}${content.length > 0 ? "\n" : ""}${markerText}`,
		truncated: true,
		omittedChars: Math.max(0, sanitized.length - content.length),
		omittedLines,
	};
};

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
		return "[tool output depth truncated]";
	}
	if (Array.isArray(value)) {
		const values = value
			.slice(0, MAX_OUTPUT_ENTRIES)
			.map((item) => presentOutputValue(item, depth + 1));
		if (value.length > MAX_OUTPUT_ENTRIES) {
			values.push(`[${value.length - MAX_OUTPUT_ENTRIES} more items]`);
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
			output.__truncated__ = `[${entries.length - MAX_OUTPUT_ENTRIES} more fields]`;
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
		return "[argument depth truncated]";
	}
	if (Array.isArray(value)) {
		const values = value
			.slice(0, MAX_ARGUMENT_ENTRIES)
			.map((item) => presentArgumentValue(item, depth + 1));
		if (value.length > MAX_ARGUMENT_ENTRIES) {
			values.push(`[${value.length - MAX_ARGUMENT_ENTRIES} more items]`);
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
			output.__truncated__ = `[${entries.length - MAX_ARGUMENT_ENTRIES} more fields]`;
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

const DIFF_TOOL_NAMES = new Set(["Edit", "ApplyPatch", "edit", "apply_patch"]);

export const isDiffTool = (name: string): boolean => DIFF_TOOL_NAMES.has(name);

const looksLikeDiff = (value: string): boolean => {
	const lines = value.split("\n");
	const hasHeader = lines.some(
		(line) =>
			line.startsWith("diff ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("@@ ")
	);
	const hasChangePair =
		lines.some((line) => line.startsWith("+")) &&
		lines.some((line) => line.startsWith("-"));
	return hasHeader || hasChangePair;
};

const findDiffText = (value: ChatToolResult, depth = 0): string | undefined => {
	if (depth > 3) {
		return undefined;
	}
	const text = transcriptTextSchema.safeParse(value);
	if (text.success) {
		return looksLikeDiff(text.data) ? text.data : undefined;
	}
	if (
		value === undefined ||
		transcriptScalarSchema.safeParse(value).success ||
		Array.isArray(value)
	) {
		return undefined;
	}
	for (const key of ["patch", "diff", "unified_diff", "unifiedDiff"]) {
		const candidate = transcriptTextSchema.safeParse(
			transcriptField(value, key)
		);
		if (candidate.success && looksLikeDiff(candidate.data)) {
			return candidate.data;
		}
	}
	for (const key of ["output", "result", "content", "text"]) {
		const nested = findDiffText(transcriptField(value, key), depth + 1);
		if (nested) {
			return nested;
		}
	}
	return undefined;
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

/**
 * Collapse whitespace to one row and clamp it to `maxChars` with an ellipsis.
 * `keep: "end"` drops the start instead, so a long path keeps its file name.
 */
const clampTerminalLine = (
	value: string,
	maxChars: number,
	keep: "start" | "end" = "start"
): string => {
	const line = value.replace(/\s+/g, " ").trim();
	const limit = normalizedLimit(maxChars);
	const chars = [...line];
	if (chars.length <= limit) {
		return line;
	}
	const budget = Math.max(1, limit - 1);
	return keep === "end"
		? `…${chars.slice(-budget).join("").trimStart()}`
		: `${chars.slice(0, budget).join("").trimEnd()}…`;
};

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

/** `4.2s` / `1m 5s`, or undefined when either timestamp is missing (legacy parts). */
export const formatReasoningDuration = (
	startedAt: number | undefined,
	endedAt: number | undefined
): string | undefined => {
	if (
		startedAt === undefined ||
		endedAt === undefined ||
		!Number.isFinite(startedAt) ||
		!Number.isFinite(endedAt) ||
		endedAt < startedAt
	) {
		return;
	}
	const seconds = (endedAt - startedAt) / 1000;
	if (seconds < 59.95) {
		return `${seconds.toFixed(1)}s`;
	}
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m ${whole % 60}s`;
};

type ToolKind = "read" | "bash" | "edit" | "write" | "search" | "fetch";

const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
	read: "read",
	read_file: "read",
	readfile: "read",
	view: "read",
	bash: "bash",
	shell: "bash",
	exec: "bash",
	execute: "bash",
	run_command: "bash",
	terminal: "bash",
	edit: "edit",
	edit_file: "edit",
	multiedit: "edit",
	multi_edit: "edit",
	str_replace: "edit",
	apply_patch: "edit",
	applypatch: "edit",
	write: "write",
	write_file: "write",
	create_file: "write",
	grep: "search",
	glob: "search",
	search: "search",
	find: "search",
	webfetch: "fetch",
	web_fetch: "fetch",
	fetch: "fetch",
};

/**
 * Classify a tool by name across agents: case-insensitive, snake/kebab/camel
 * variants (`read_file`, `ReadFile`), and MCP-prefixed names (`mcp__fs__read_file`).
 */
const toolKind = (name: string): ToolKind | undefined => {
	const base = name.split("__").at(-1) ?? name;
	const normalized = base
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[\s.-]+/g, "_");
	return (
		TOOL_KIND_BY_NAME[normalized] ??
		TOOL_KIND_BY_NAME[normalized.replace(/_/g, "")]
	);
};

/** ACP tool updates nest the agent's own input under `rawInput`. */
const toolInputRecord = (
	args: ChatToolArguments | undefined
): ChatToolArguments | undefined => asRecord(args?.rawInput) ?? args;

const stringArg = (
	input: ChatToolArguments,
	keys: readonly string[]
): string | undefined => {
	for (const key of keys) {
		const value = transcriptTextSchema.safeParse(input[key]);
		if (value.success && value.data.trim().length > 0) {
			return value.data;
		}
	}
	return undefined;
};

const numberArg = (
	input: ChatToolArguments,
	key: string
): number | undefined => {
	const value = z.number().finite().safeParse(input[key]);
	return value.success ? value.data : undefined;
};

const PATH_KEYS = ["file_path", "path", "filePath", "file", "filename"];
const PATCH_FILE_HEADER =
	/^(?:\+\+\+ (?:b\/)?|\*\*\* (?:Update|Add|Delete) File: )(\S.*)$/m;

const summaryLine = (value: string, keep: "start" | "end" = "start"): string =>
	clampTerminalLine(
		sanitizeTerminalText(value),
		TRANSCRIPT_LIMITS.toolSummaryChars,
		keep
	);

const pathSummary = (path: string): string => summaryLine(path, "end");

const readSummary = (input: ChatToolArguments): string | undefined => {
	const path = stringArg(input, PATH_KEYS);
	if (!path) {
		return undefined;
	}
	const offset = numberArg(input, "offset");
	const limit = numberArg(input, "limit");
	const range =
		offset !== undefined && limit !== undefined
			? `:${offset}-${offset + limit}`
			: "";
	// Clamp the path to what the range leaves so the whole summary stays bounded.
	return `${clampTerminalLine(
		sanitizeTerminalText(path),
		TRANSCRIPT_LIMITS.toolSummaryChars - range.length,
		"end"
	)}${range}`;
};

const bashSummary = (input: ChatToolArguments): string | undefined => {
	const commandParts = z.array(z.string()).safeParse(input.command);
	const command = commandParts.success
		? commandParts.data.join(" ")
		: stringArg(input, ["command", "cmd", "script"]);
	if (!command) {
		return undefined;
	}
	const lines = sanitizeTerminalText(command)
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const first = lines[0] ?? "";
	return summaryLine(`$ ${first}${lines.length > 1 ? " …" : ""}`);
};

const editSummary = (input: ChatToolArguments): string | undefined => {
	const path = stringArg(input, PATH_KEYS);
	if (path) {
		return pathSummary(path);
	}
	const patch = stringArg(input, ["patch", "diff", "input"]);
	const header = patch ? PATCH_FILE_HEADER.exec(patch)?.[1] : undefined;
	return header ? pathSummary(header) : undefined;
};

const searchSummary = (input: ChatToolArguments): string | undefined => {
	const pattern = stringArg(input, ["pattern", "query", "glob", "regex"]);
	if (!pattern) {
		return undefined;
	}
	const path = stringArg(input, ["path", "cwd", "directory", "dir"]);
	return summaryLine(`"${pattern}"${path ? ` in ${path}` : ""}`);
};

const fetchSummary = (input: ChatToolArguments): string | undefined => {
	const url = stringArg(input, ["url", "uri", "href"]);
	if (!url) {
		return undefined;
	}
	try {
		return summaryLine(new URL(url).host || url);
	} catch {
		return summaryLine(url);
	}
};

const firstStringSummary = (input: ChatToolArguments): string | undefined => {
	for (const [key, value] of Object.entries(input)) {
		if (key === "rawInput") {
			continue;
		}
		const text = transcriptTextSchema.safeParse(value);
		if (text.success && text.data.trim().length > 0) {
			return summaryLine(text.data);
		}
	}
	return undefined;
};

/**
 * One-row argument summary for a collapsed tool row: `src/a.ts:10-60`,
 * `$ bun test`, `"foo" in src`, `example.com`. Always sanitized, single-line,
 * and clamped to TRANSCRIPT_LIMITS.toolSummaryChars.
 */
export const toolSummary = (
	name: string,
	args?: ChatToolArguments
): string | undefined => {
	const input = toolInputRecord(args);
	if (!input) {
		return undefined;
	}
	const kind = toolKind(name);
	let summary: string | undefined;
	switch (kind) {
		case "read":
			summary = readSummary(input);
			break;
		case "bash":
			summary = bashSummary(input);
			break;
		case "edit":
		case "write":
			summary = editSummary(input);
			break;
		case "search":
			summary = searchSummary(input);
			break;
		case "fetch":
			summary = fetchSummary(input);
			break;
		default:
			break;
	}
	const resolved = summary ?? firstStringSummary(input);
	return resolved && resolved.length > 0 ? resolved : undefined;
};

const countLines = (value: string): number =>
	value.length === 0 ? 0 : value.split("\n").length;

const patchDiffStat = (patch: string): { added: number; removed: number } => {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) {
			continue;
		}
		if (line.startsWith("+")) {
			added++;
		} else if (line.startsWith("-")) {
			removed++;
		}
	}
	return { added, removed };
};

/**
 * `+N -M` line counts for an edit: from a patch/diff argument, an
 * old/new string pair, or a diff the tool returned in its result.
 */
export const toolDiffStat = (
	name: string,
	args: ChatToolArguments | undefined,
	result: ChatToolResult
): { added: number; removed: number } | undefined => {
	if (!(toolKind(name) === "edit" || isDiffTool(name))) {
		return undefined;
	}
	const input = toolInputRecord(args) ?? {};
	const patch = stringArg(input, ["patch", "diff"]);
	if (patch) {
		return patchDiffStat(patch);
	}
	const oldText = stringArg(input, ["old_string", "oldString"]);
	const newText = stringArg(input, ["new_string", "newString"]);
	if (oldText !== undefined || newText !== undefined) {
		return {
			added: countLines(newText ?? ""),
			removed: countLines(oldText ?? ""),
		};
	}
	const resultDiff = findDiffText(result);
	return resultDiff ? patchDiffStat(resultDiff) : undefined;
};

const TOOL_PENDING_LABELS: Record<ToolKind, string> = {
	read: "Reading",
	bash: "Running",
	edit: "Editing",
	write: "Writing",
	search: "Searching",
	fetch: "Fetching",
};

/** Gerund label for an in-flight tool row (`Reading`, `Running`), else the name. */
export const toolPendingLabel = (name: string): string => {
	const kind = toolKind(name);
	return kind ? TOOL_PENDING_LABELS[kind] : name;
};

const TOOL_ACTIVITY_LABELS: Record<ToolKind, string> = {
	read: "Reading files…",
	bash: "Running command…",
	edit: "Editing files…",
	write: "Writing files…",
	search: "Searching…",
	fetch: "Fetching…",
};

// Unknown tool names (often long `mcp__server__tool` ids) are clamped so the
// one-row status line keeps its elapsed time and `Esc interrupt` hint on an
// 80-column terminal next to the sidebar.
const TOOL_ACTIVITY_NAME_CHARS = 22;

/**
 * Status-row activity for the tool a turn is running (`Running command…`),
 * falling back to `Running <name>…` for tools without a known kind.
 */
export const toolActivityLabel = (name: string): string => {
	const kind = toolKind(name);
	if (kind) {
		return TOOL_ACTIVITY_LABELS[kind];
	}
	const trimmed = clampTerminalLine(
		sanitizeTerminalText(name),
		TOOL_ACTIVITY_NAME_CHARS
	).replace(/…$/u, "");
	return trimmed.length > 0 ? `Running ${trimmed}…` : "Running tool…";
};

/**
 * `42ms`, `0.3s`, `2.1s`, `1m 4s`. Only sub-100ms calls keep milliseconds;
 * everything else reads like the reasoning row's one-decimal seconds.
 */
export const formatToolDuration = (ms: number): string => {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	if (safe < 100) {
		return `${Math.round(safe)}ms`;
	}
	const seconds = safe / 1000;
	if (seconds < 59.95) {
		return `${seconds.toFixed(1)}s`;
	}
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m ${whole % 60}s`;
};

/** Settled duration of a tool part, or undefined for legacy/unsettled parts. */
export const toolDurationMs = (part: {
	endedAt?: number;
	startedAt?: number;
}): number | undefined => {
	const { endedAt, startedAt } = part;
	if (
		startedAt === undefined ||
		endedAt === undefined ||
		!Number.isFinite(startedAt) ||
		!Number.isFinite(endedAt) ||
		endedAt < startedAt
	) {
		return undefined;
	}
	return endedAt - startedAt;
};
