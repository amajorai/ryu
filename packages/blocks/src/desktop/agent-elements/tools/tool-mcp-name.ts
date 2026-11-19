// MCP tool part types: parse `tool-mcp-<server>-<tool>` and format display names.

const MCP_TOOL_PREFIX = "tool-mcp-";
const LEGACY_MCP_TOOL_PREFIX = "tool-mcp__";

export interface McpToolInfo {
	category: string;
	displayName: string;
	serverName: string;
	toolName: string;
}

/** Human-facing label for a qualified tool id; the id itself remains the call key. */
export function formatToolDisplayName(toolName: string): string {
	const dotIndex = toolName.lastIndexOf(".");
	const legacyIndex = toolName.lastIndexOf("__");
	const separatorIndex = Math.max(dotIndex, legacyIndex);
	const separatorLength = separatorIndex === legacyIndex ? 2 : 1;
	const displayName =
		separatorIndex === -1
			? toolName
			: toolName.slice(separatorIndex + separatorLength);
	return displayName
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase())
		.trim();
}

const BUILTIN_MCP_TOOLS = new Map<string, McpToolInfo>(
	Object.entries({
		"tool-ListMcpResources": {
			serverName: "mcp",
			toolName: "list_resources",
			displayName: "List Resources",
			category: "list",
		},
		"tool-ListMcpResourcesTool": {
			serverName: "mcp",
			toolName: "list_resources",
			displayName: "List Resources",
			category: "list",
		},
		"tool-ReadMcpResource": {
			serverName: "mcp",
			toolName: "read_resource",
			displayName: "Read Resource",
			category: "get",
		},
		"tool-ReadMcpResourceTool": {
			serverName: "mcp",
			toolName: "read_resource",
			displayName: "Read Resource",
			category: "get",
		},
	})
);

export function parseMcpToolType(partType: string): McpToolInfo | null {
	const builtin = BUILTIN_MCP_TOOLS.get(partType);
	if (builtin) {
		return builtin;
	}
	const isLegacy = partType.startsWith(LEGACY_MCP_TOOL_PREFIX);
	if (!(isLegacy || partType.startsWith(MCP_TOOL_PREFIX))) {
		return null;
	}
	const prefix = isLegacy ? LEGACY_MCP_TOOL_PREFIX : MCP_TOOL_PREFIX;
	const separator = isLegacy ? "__" : ".";
	const withoutPrefix = partType.slice(prefix.length);
	const separatorIndex = withoutPrefix.indexOf(separator);
	if (separatorIndex === -1) {
		return null;
	}
	const serverName = withoutPrefix.slice(0, separatorIndex);
	const toolName = withoutPrefix.slice(separatorIndex + separator.length);
	return {
		serverName,
		toolName,
		displayName: formatToolDisplayName(toolName),
		category: "other",
	};
}

/**
 * The built-in MCP resource tools in the UI language. A server's own tool
 * names stay as the server wrote them.
 */
export function mcpToolLabel(
	info: McpToolInfo,
	tl: (source: string) => string
): string {
	if (info.serverName !== "mcp") {
		return info.displayName;
	}
	if (info.toolName === "list_resources") {
		return tl("List Resources");
	}
	if (info.toolName === "read_resource") {
		return tl("Read Resource");
	}
	return info.displayName;
}
