import { type DefaultError, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { agentListOptions } from "@/src/lib/agent-list-query.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	callMcpTool as apiCallMcpTool,
	createMcpServer as apiCreateMcpServer,
	deleteMcpServer as apiDeleteMcpServer,
	updateMcpServer as apiUpdateMcpServer,
	type CreateMcpServerInput,
	type CreateMcpServerResult,
	fetchMcpServers,
	fetchMcpTools,
	type McpCallResult,
	type McpServer,
	type McpTool,
	type UpdateMcpServerInput,
	type UpdateMcpServerResult,
} from "@/src/lib/api/mcp.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseMcpResult {
	/** The agent whose allowlist currently filters the tool list (null = all). */
	agentFilter: string | null;
	agents: AgentSummary[];
	callTool: (
		tool: string,
		agentId: string,
		args: Parameters<typeof apiCallMcpTool>[1]["arguments"]
	) => Promise<McpCallResult>;
	/** Register a new MCP server and reload the list on success. */
	createServer: (input: CreateMcpServerInput) => Promise<CreateMcpServerResult>;
	deleteServer: (name: string) => Promise<{ error?: string; ok: boolean }>;
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	servers: McpServer[];
	serversError: string | null;
	serversLoading: boolean;
	setAgentFilter: (agentId: string | null) => void;
	tools: McpTool[];
	toolsError: string | null;
	toolsLoading: boolean;
	updateServer: (
		name: string,
		input: UpdateMcpServerInput
	) => Promise<UpdateMcpServerResult>;
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
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;

	const [agentFilter, setAgentFilter] = useState<string | null>(null);
	const scope = useMemo(
		() => [url, token, userJwt] as const,
		[url, token, userJwt]
	);
	const serversKey = useMemo(() => ["mcp-servers", ...scope], [scope]);
	const toolsPrefix = useMemo(() => ["mcp-tools", ...scope], [scope]);
	const agentsOptions = useMemo(
		() => agentListOptions({ url, token, userJwt }),
		[url, token, userJwt]
	);
	const agentsKey = agentsOptions.queryKey;
	const serversOptions = useMemo(
		() => ({
			queryKey: serversKey,
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchMcpServers({ url, token, userJwt }, signal),
			staleTime: 30_000,
		}),
		[serversKey, token, url, userJwt]
	);
	const toolsOptions = useMemo(
		() => ({
			queryKey: [...toolsPrefix, agentFilter],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchMcpTools(
					{ url, token, userJwt },
					agentFilter ?? undefined,
					signal
				),
			staleTime: 30_000,
		}),
		[agentFilter, token, toolsPrefix, url, userJwt]
	);
	const serversQuery = useQuery(serversOptions, queryClient);
	const toolsQuery = useQuery(toolsOptions, queryClient);
	const agentsQuery = useQuery(agentsOptions, queryClient);
	const servers = serversQuery.data ?? [];
	const tools = toolsQuery.data ?? [];
	const agents = agentsQuery.data ?? [];
	// Agent options are supplemental; a slow roster must not block server/tool browsing.
	const loading = serversQuery.isPending || toolsQuery.isPending;
	const describeError = (failure: DefaultError | null): string | null =>
		failure
			? failure instanceof Error
				? failure.message
				: "Failed to load MCP registry"
			: null;
	const serversError = describeError(serversQuery.error);
	const toolsError = describeError(toolsQuery.error);
	const error = serversError ?? toolsError;
	const reload = useCallback(async () => {
		await Promise.all(
			[serversKey, toolsPrefix, agentsKey].map((queryKey) =>
				queryClient.refetchQueries(
					{ queryKey, type: "active" },
					{ cancelRefetch: false }
				)
			)
		);
	}, [serversKey, toolsPrefix, agentsKey]);
	const refreshRegistry = useCallback(async () => {
		// A successful mutation supersedes reads started before it, including first loads.
		await Promise.all(
			[serversKey, toolsPrefix].map((queryKey) =>
				queryClient.cancelQueries({ queryKey })
			)
		);
		await Promise.all(
			[serversKey, toolsPrefix].map((queryKey) =>
				queryClient.invalidateQueries({ queryKey })
			)
		);
	}, [serversKey, toolsPrefix]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const callTool = useCallback(
		(
			tool: string,
			agentId: string,
			args: Parameters<typeof apiCallMcpTool>[1]["arguments"]
		) =>
			apiCallMcpTool(
				{ url, token, userJwt },
				{ tool, agentId, arguments: args }
			),
		[url, token, userJwt]
	);

	const createServer = useCallback(
		async (input: CreateMcpServerInput): Promise<CreateMcpServerResult> => {
			const result = await apiCreateMcpServer({ url, token, userJwt }, input);
			if (result.ok) {
				// Reload the server + tool list so the new server appears without
				// requiring a manual refresh.
				await refreshRegistry();
			}
			return result;
		},
		[url, token, userJwt, refreshRegistry]
	);

	const updateServer = useCallback(
		async (
			name: string,
			input: UpdateMcpServerInput
		): Promise<UpdateMcpServerResult> => {
			const result = await apiUpdateMcpServer(
				{ url, token, userJwt },
				name,
				input
			);
			if (result.ok) {
				await refreshRegistry();
			}
			return result;
		},
		[url, token, userJwt, refreshRegistry]
	);

	const deleteServer = useCallback(
		async (name: string) => {
			const result = await apiDeleteMcpServer({ url, token, userJwt }, name);
			if (result.ok) {
				await refreshRegistry();
			}
			return result;
		},
		[url, token, userJwt, refreshRegistry]
	);

	return {
		servers,
		tools,
		agents,
		agentFilter,
		setAgentFilter,
		loading,
		serversLoading: serversQuery.isPending,
		toolsLoading: toolsQuery.isPending,
		serversError,
		toolsError,
		error,
		reload,
		callTool,
		createServer,
		updateServer,
		deleteServer,
	};
}
