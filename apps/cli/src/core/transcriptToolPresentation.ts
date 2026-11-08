// Tool and reasoning rows: one-line summaries, diff stats, in-flight labels and
// durations, formatted in the CLI locale.

import { z } from "zod";
import { formatCliElapsed } from "../i18n/format.ts";
import { tf, tr } from "../i18n/translate.ts";
import {
	asRecord,
	type ChatToolArguments,
	type ChatToolResult,
} from "./chatTranscript.ts";
import {
	clampTerminalLine,
	sanitizeTerminalText,
} from "./transcriptTerminalText.ts";
import {
	findDiffText,
	isDiffTool,
	TRANSCRIPT_LIMITS,
	transcriptTextSchema,
} from "./transcriptValues.ts";

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
	return formatCliElapsed(endedAt - startedAt);
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
export const toolActivityLabel = (
	name: string,
	translate: (value: string) => string = tr
): string => {
	const kind = toolKind(name);
	if (kind) {
		return translate(TOOL_ACTIVITY_LABELS[kind]);
	}
	const trimmed = clampTerminalLine(
		sanitizeTerminalText(name),
		TOOL_ACTIVITY_NAME_CHARS
	).replace(/…$/u, "");
	return trimmed.length > 0
		? tf("Running {trimmed}…", { trimmed })
		: tr("Running tool…");
};

/**
 * `42ms`, `0.3s`, `2.1s`, `1m 4s`. Only sub-100ms calls keep milliseconds;
 * everything else reads like the reasoning row's one-decimal seconds.
 */
export const formatToolDuration = (ms: number): string =>
	formatCliElapsed(ms, { milliseconds: true });

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
