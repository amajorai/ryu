import {
	ConnectIcon,
	File01Icon,
	Globe02Icon,
	Mail01Icon,
	Package01Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { PATH_KEYS } from "@/src/lib/mission-control/turn-groups.ts";
import type { DerivedSource } from "./cowork-types.ts";

/** Beyond this the list stops being a summary; the rest collapse to "+N more". */
export const MAX_SOURCE_ITEMS = 40;
export const MAX_ITEM_CHARS = 160;
export const FIRST_LINE_RE = /\r?\n[\s\S]*$/;
export const CHAT_ATTACHMENTS_SOURCE = {
	id: "attachments",
	label: "Chat attachments",
	icon: File01Icon,
} as const;

export function nonEmptyString<TValue>(value: TValue): string | undefined {
	return isNativeText(value) && value.length > 0 ? value : undefined;
}

// Tool-name sets, not part types: a tool arrives either as `tool-<Name>` or as a
// `dynamic-tool` carrying `toolName`, and ACP bridges use their own names for
// the same operations. `toolNameOf` normalises both shapes.
export const FILE_TOOLS = new Set([
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"NotebookRead",
	"apply_patch",
	"create_file",
	"str_replace_editor",
	"view_file",
]);
export const SEARCH_TOOLS = new Set([
	"Grep",
	"Glob",
	"codebase_search",
	"file_search",
]);
export const SHELL_TOOLS = new Set([
	"Bash",
	"BashOutput",
	"run_terminal_cmd",
	"shell",
]);
export const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "web_search"]);

type SourceToolKind = "app" | "integration" | "mcp";

interface ParsedSourceTool {
	kind: SourceToolKind;
	operation: string;
	source: Omit<DerivedSource, "items">;
}

// These qualified names are Ryu's own rendering/orchestration tools, not
// external sources. Keep them out of Sources while allowing provider facades
// such as browser.* and memory.* to remain visible when they are actually used.
const INTERNAL_QUALIFIED_TOOL_NAMESPACES = new Set([
	"agents",
	"artifact",
	"delegate",
	"describe",
	"execute",
	"resume",
	"skills",
	"threads",
	"tool_search",
	"ui",
]);

export const TOOL_ARGUMENT_KEYS = [
	"query",
	"question",
	"email",
	"name",
	"id",
	"issue",
	"subject",
	"title",
	"summary",
	"channel",
	"message",
	"text",
	"repository",
	"repo",
	"owner",
	"project",
	"url",
	"link",
	"uri",
	...PATH_KEYS,
];

function splitFirstQualifiedPart(
	value: string,
	separator: "." | "__"
): [string, string] | null {
	const at = value.indexOf(separator);
	if (at <= 0 || at + separator.length >= value.length) {
		return null;
	}
	return [value.slice(0, at), value.slice(at + separator.length)];
}

function splitQualifiedTool(value: string): [string, string] | null {
	const dot = value.indexOf(".");
	const legacy = value.indexOf("__");
	if (dot === -1 && legacy === -1) {
		return null;
	}
	if (legacy === -1 || (dot !== -1 && dot < legacy)) {
		return splitFirstQualifiedPart(value, ".");
	}
	return splitFirstQualifiedPart(value, "__");
}

function prettySourceLabel(value: string): string {
	const normalized = value
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function prettyOperationLabel(value: string): string {
	const normalized = prettySourceLabel(value);
	return normalized
		? normalized.charAt(0) + normalized.slice(1).toLowerCase()
		: "Tool";
}

function parseMcpToolName(tool: string): [string, string] | null {
	const dotted = /^mcp\.(.+)$/i.exec(tool)?.[1];
	if (dotted) {
		return splitFirstQualifiedPart(dotted, ".");
	}
	const dashed = /^mcp-(.+)$/i.exec(tool)?.[1];
	if (dashed) {
		return splitQualifiedTool(dashed);
	}
	const legacy = /^mcp__(.+)$/i.exec(tool)?.[1];
	return legacy ? splitQualifiedTool(legacy) : null;
}

function parseAppToolName(tool: string): [string, string] | null {
	const dotted = /^app\.(.+)$/i.exec(tool)?.[1];
	const legacy = /^app__(.+)$/i.exec(tool)?.[1];
	const rest = dotted ?? legacy;
	if (!rest) {
		return null;
	}
	return splitQualifiedTool(rest) ?? ["apps", rest];
}

export function parseSourceTool(tool: string): ParsedSourceTool | null {
	const mcp = parseMcpToolName(tool);
	if (mcp) {
		const [rawServer, operation] = mcp;
		const server = rawServer.toLowerCase();
		if (server.includes("gmail") || server.includes("mail")) {
			return {
				kind: "mcp",
				operation,
				source: { id: "gmail", label: "Gmail", icon: Mail01Icon },
			};
		}
		if (server.includes("github") || server.includes("git")) {
			return {
				kind: "mcp",
				operation,
				source: { id: "github", label: "GitHub", icon: SourceCodeIcon },
			};
		}
		return {
			kind: "mcp",
			operation,
			source: {
				id: `mcp-${server}`,
				label: prettySourceLabel(rawServer),
				icon: Globe02Icon,
			},
		};
	}

	const composio = /^composio(?:\.|__)(.+)$/i.exec(tool)?.[1];
	if (composio) {
		return {
			kind: "integration",
			operation: composio,
			source: { id: "composio", label: "Composio", icon: ConnectIcon },
		};
	}

	const app = parseAppToolName(tool);
	if (app) {
		const [rawApp, operation] = app;
		const appName = rawApp.toLowerCase();
		return {
			kind: "app",
			operation,
			source: {
				id: `app-${appName}`,
				label: appName === "apps" ? "Apps" : prettySourceLabel(rawApp),
				icon: Package01Icon,
			},
		};
	}

	const qualified = splitQualifiedTool(tool);
	if (!qualified) {
		return null;
	}
	const [namespace, operation] = qualified;
	if (INTERNAL_QUALIFIED_TOOL_NAMESPACES.has(namespace.toLowerCase())) {
		return null;
	}
	const normalizedNamespace = namespace.toLowerCase();
	return {
		kind: "mcp",
		operation,
		source: {
			id: `mcp-${normalizedNamespace}`,
			label: prettySourceLabel(namespace),
			icon: Globe02Icon,
		},
	};
}
