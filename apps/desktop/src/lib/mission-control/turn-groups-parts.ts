// apps/desktop/src/lib/mission-control/turn-groups-parts.ts
//
// Text limits, tool-family tables, untyped-input readers and part
// classification for the Mission Control digest, split out of
// `turn-groups.ts` (which re-exports the public symbols).

import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import type { DynamicToolUIPart } from "ai";
import { z } from "zod";
import type {
	MissionStreamPart,
	MissionTodo,
	MissionTouchKind,
} from "./turn-groups-types.ts";

// ── Text limits ───────────────────────────────────────────────────────────────
// Card copy, not storage: the panel shows a readable excerpt and the full text
// stays one click away in the transcript itself.
export const MAX_REQUEST_CHARS = 240;
export const MAX_RATIONALE_CHARS = 600;
export const MAX_OUTCOME_CHARS = 600;
export const MAX_THINKING_CHARS = 600;
export const MAX_HEADLINE_PATHS = 2;

const TOOL_PART_PREFIX = "tool-";
const DYNAMIC_TOOL_PART = "dynamic-tool";
export const PLAN_TOOL = "TodoWrite";

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
export const SHELL_TOOLS = new Set([
	"Bash",
	"BashOutput",
	"run_terminal_cmd",
	"shell",
]);
export const SEARCH_TOOLS = new Set([
	"Grep",
	"Glob",
	"codebase_search",
	"file_search",
]);
export const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "web_search"]);
export const DELEGATE_TOOLS = new Set(["Task", "Agent", "Workflow"]);

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
export function readString(
	source: MissionRawInput,
	key: string
): string | undefined {
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

export function partText(part: MissionStreamPart): string {
	const parsed = z.string().safeParse(part.text);
	return parsed.success ? parsed.data.trim() : "";
}

export function clamp(text: string, max: number): string {
	const collapsed = text.trim();
	if (collapsed.length <= max) {
		return collapsed;
	}
	return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** The last path segment, for headlines that shouldn't show a whole repo path. */
export function baseName(path: string): string {
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

export function isFailure(part: MissionStreamPart): boolean {
	return part.state === "output-error";
}

/** A tool call with no terminal frame yet — the turn is still working. */
export function isPending(part: MissionStreamPart): boolean {
	return part.state !== "output-error" && part.state !== "output-available";
}

export function touchKindFor(tool: string): MissionTouchKind | undefined {
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

export function readTodos(input: MissionRawInput): MissionTodo[] {
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
