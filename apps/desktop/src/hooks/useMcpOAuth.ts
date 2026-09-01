import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	connectMcpOAuth,
	disconnectMcpOAuth,
	fetchMcpOAuth,
	fetchMcpOAuthFlow,
} from "@/src/lib/api/mcp-oauth.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { useActiveNode } from "./useActiveNode.ts";

const useTarget = (): ApiTarget => {
	const activeNode = useActiveNode();
	return {
		token: activeNode.token,
		userJwt: activeNode.userJwt ?? null,
		url: activeNode.url,
	};
};

export const useMcpOAuthConnections = (pluginId: string) => {
	const target = useTarget();
	return useQuery({
		queryFn: () => fetchMcpOAuth(target, pluginId),
		queryKey: ["mcp-oauth", target.url, pluginId],
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});
};

export const useMcpOAuthFlow = (pluginId: string, flowId: string | null) => {
	const target = useTarget();
	return useQuery({
		enabled: flowId !== null,
		queryFn: () => fetchMcpOAuthFlow(target, pluginId, flowId ?? ""),
		queryKey: ["mcp-oauth-flow", target.url, pluginId, flowId],
		refetchInterval: (query) =>
			query.state.data?.status === "pending" ? 1000 : false,
	});
};

export const useConnectMcpOAuth = (pluginId: string) => {
	const target = useTarget();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accessLevel,
			profileId,
			serverName,
		}: {
			accessLevel: ConnectionAccessLevel;
			profileId: string;
			serverName: string;
		}) => connectMcpOAuth(target, pluginId, serverName, profileId, accessLevel),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["mcp-oauth", target.url, pluginId],
			});
		},
	});
};

export const useDisconnectMcpOAuth = (pluginId: string) => {
	const target = useTarget();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			profileId,
			serverName,
		}: {
			profileId: string;
			serverName: string;
		}) => disconnectMcpOAuth(target, pluginId, serverName, profileId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["mcp-oauth", target.url, pluginId],
			});
		},
	});
};
