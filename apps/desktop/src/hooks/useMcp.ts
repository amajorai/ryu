import { useCallback, useEffect, useState } from "react";
import { type AgentSummary, fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	callMcpTool as apiCallMcpTool,
	createMcpServer as apiCreateMcpServer,
	type CreateMcpServerInput,
	type CreateMcpServerResult,
	fetchMcpServers,
	fetchMcpTools,
	type McpCallResult,
	type McpServer,
	type McpTool,
} from "@/src/lib/api/mcp.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseMcpResult {
	/** The agent whose allowlist currently filters the tool list (null = all). */
	agentFilter: string | null;
	agents: AgentSummary[];
	callTool: (
		tool: string,
		agentId: string,
		args: unknown
	) => Promise<McpCallResult>;
	/** Register a new MCP server and reload the list on success. */
	createServer: (input: CreateMcpServerInput) => Promise<CreateMcpServerResult>;
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	servers: McpServer[];
	setAgentFilter: (agentId: string | null) => void;
	tools: McpTool[];
}

/// Loads MCP servers, tools, and user agents from the active Core node. The tool
/// list re-fetches whenever the agent filter changes so the per-agent allowlist
/// is resolved server-side (Core narrows `/api/mcp/tools?agent=` to the agent's
/// allowlist). Agents double as the filter options and the gate for test calls.
export function useMcp(): UseMcpResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const [servers, setServers] = useState<McpServer[]>([]);
	const [tools, setTools] = useState<McpTool[]>([]);
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [agentFilter, setAgentFilter] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		const node: ApiTarget = { url, token };
		try {
			const [serverList, toolList, agentList] = await Promise.all([
				fetchMcpServers(node),
				fetchMcpTools(node, agentFilter ?? undefined),
				fetchAgents(node).catch(() => []),
			]);
			setServers(serverList);
			setTools(toolList);
			setAgents(agentList);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load MCP registry");
		} finally {
			setLoading(false);
		}
	}, [url, token, agentFilter]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const callTool = useCallback(
		(tool: string, agentId: string, args: unknown) =>
			apiCallMcpTool({ url, token }, { tool, agentId, arguments: args }),
		[url, token]
	);

	const createServer = useCallback(
		async (input: CreateMcpServerInput): Promise<CreateMcpServerResult> => {
			const result = await apiCreateMcpServer({ url, token }, input);
			if (result.ok) {
				// Reload the server + tool list so the new server appears without
				// requiring a manual refresh.
				await reload();
			}
			return result;
		},
		[url, token, reload]
	);

	return {
		servers,
		tools,
		agents,
		agentFilter,
		setAgentFilter,
		loading,
		error,
		reload,
		callTool,
		createServer,
	};
}
