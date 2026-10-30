import type { callMcpTool, McpCallResult } from "@ryuhq/core-client/mcp";

export interface McpServerRow {
	args: string[];
	available?: boolean;
	command: string;
	description?: string | null;
	enabled: boolean;
	name: string;
}

export interface McpToolRow {
	description?: string | null;
	id: string;
	name: string;
	server: string;
}

export interface AgentOption {
	id: string;
	name: string;
}

/** The actual native Core MCP call result, including its opaque output slot. */
export type ToolCallResult = McpCallResult;

/** The existing Core call serialization input; no decoded arguments DTO. */
export type McpCallArguments = Parameters<typeof callMcpTool>[1]["arguments"];

export interface CreateServerResult {
	error?: string;
	ok: boolean;
}

export interface CreateServerInput {
	args: string[];
	command: string;
	description?: string;
	name: string;
}

export interface ToolsViewProps {
	agentFilter?: string | null;
	agents: AgentOption[];
	error?: string | null;
	loading?: boolean;
	onAgentFilterChange?: (agentId: string | null) => void;
	onCallTool?: (
		tool: string,
		agentId: string,
		args: McpCallArguments
	) => Promise<ToolCallResult>;
	onCreateServer?: (input: CreateServerInput) => Promise<CreateServerResult>;
	onRetry?: () => void;
	servers: McpServerRow[];
	tools: McpToolRow[];
}
