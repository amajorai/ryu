// apps/desktop/src/hooks/useComposioCatalog.ts
//
// TanStack Query hooks backing the agent editor's Composio pickers. Status tells
// the editor whether a key is configured; toolkits/actions/triggers are browsed
// on demand (a toolkit's actions are only fetched once the user expands it). All
// data decisions live in Core; these are thin cached fetchers.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AgentComposioConnections,
	type ComposioAction,
	type ComposioConnectInitiate,
	type ComposioConnection,
	type ComposioStatus,
	type ComposioToolkit,
	type ComposioTrigger,
	disconnectAgentComposioConnection,
	fetchAgentComposioConnections,
	fetchComposioActions,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	fetchComposioTriggers,
	initiateAgentComposioConnection,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { useActiveNode } from "./useActiveNode.ts";

function useTarget(): ApiTarget {
	const activeNode = useActiveNode();
	return useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
}

/** Whether a Composio key is configured on the active node. */
export function useComposioStatus() {
	const target = useTarget();
	const options = useMemo(
		() => ({
			queryKey: [
				"composio",
				"status",
				target.url,
				target.token ?? null,
				target.userJwt ?? null,
			],
			queryFn: () => fetchComposioStatus(target),
			staleTime: 30_000,
		}),
		[target]
	);
	return useQuery<ComposioStatus>(options);
}

/** Browse the user's Composio toolkits (only when `enabled`). */
export function useComposioToolkits(enabled: boolean) {
	const target = useTarget();
	const options = useMemo(
		() => ({
			queryKey: [
				"composio",
				"toolkits",
				target.url,
				target.token ?? null,
				target.userJwt ?? null,
			],
			queryFn: () => fetchComposioToolkits(target),
			enabled,
			staleTime: 5 * 60_000,
		}),
		[enabled, target]
	);
	return useQuery<ComposioToolkit[]>(options);
}

/** List a toolkit's actions (only when a toolkit is selected). */
export function useComposioActions(
	toolkit: string | null,
	query = "",
	tags: readonly string[] = []
) {
	const target = useTarget();
	const tagsKey = tags.join(",");
	// tagsKey is the content key for tags.
	const options = useMemo(
		() => ({
			queryKey: [
				"composio",
				"actions",
				target.url,
				target.token ?? null,
				target.userJwt ?? null,
				toolkit ?? "",
				query,
				tagsKey,
			],
			queryFn: () => fetchComposioActions(target, toolkit ?? "", query, tags),
			enabled: Boolean(toolkit),
			staleTime: 5 * 60_000,
		}),
		[query, tagsKey, target, toolkit]
	);
	return useQuery<ComposioAction[]>(options);
}

/** List a toolkit's trigger types (only when a toolkit is selected). */
export function useComposioTriggers(toolkit: string | null) {
	const target = useTarget();
	const options = useMemo(
		() => ({
			queryKey: [
				"composio",
				"triggers",
				target.url,
				target.token ?? null,
				target.userJwt ?? null,
				toolkit ?? "",
			],
			queryFn: () => fetchComposioTriggers(target, toolkit ?? ""),
			enabled: Boolean(toolkit),
			staleTime: 5 * 60_000,
		}),
		[target, toolkit]
	);
	return useQuery<ComposioTrigger[]>(options);
}

/**
 * The user's Composio connections (Marketplace → Connections, and the agent
 * editor's "pick from connected" picker). Optionally filtered to one toolkit.
 * Refetches on window focus so a connection authorized in the browser shows as
 * active when the user returns.
 */
export function useComposioConnections(toolkit = "", enabled = true) {
	const target = useTarget();
	const options = useMemo(
		() => ({
			queryKey: [
				"composio",
				"connections",
				target.url,
				target.token ?? null,
				target.userJwt ?? null,
				toolkit,
			],
			queryFn: () => fetchComposioConnections(target, toolkit),
			enabled,
			staleTime: 15_000,
			refetchOnWindowFocus: true,
		}),
		[enabled, target, toolkit]
	);
	return useQuery<ComposioConnection[]>(options);
}

/**
 * Initiate an OAuth connection for a toolkit. Returns the initiate result
 * ({ redirectUrl, connectionId }); the caller opens `redirectUrl` externally.
 * On success the connections query is invalidated so the new (pending → active)
 * connection appears.
 */
export function useInitiateComposioConnection() {
	const target = useTarget();
	const queryClient = useQueryClient();
	return useMutation<
		ComposioConnectInitiate,
		Error,
		{ accessLevel: ConnectionAccessLevel; toolkit: string }
	>({
		mutationFn: ({ accessLevel, toolkit }) =>
			initiateComposioConnection(target, toolkit, accessLevel),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["composio", "connections", target.url],
			});
		},
	});
}

/** The query key of one agent's own Composio connections. */
function agentComposioConnectionsKey(
	target: ApiTarget,
	agentId: string | null
) {
	return ["composio", "agent-connections", target.url, agentId] as const;
}

/**
 * The apps connected to an agent's own Composio identity. Refetches on window
 * focus so an app authorized in the browser shows as active on return.
 */
export function useAgentComposioConnections(
	agentId: string | null,
	enabled: boolean
) {
	const target = useTarget();
	const options = useMemo(
		() => ({
			queryKey: agentComposioConnectionsKey(target, agentId),
			queryFn: () => fetchAgentComposioConnections(target, agentId ?? ""),
			enabled: enabled && agentId !== null,
			retry: false,
			staleTime: 15_000,
			refetchOnWindowFocus: true,
		}),
		[agentId, enabled, target]
	);
	return useQuery<AgentComposioConnections>(options);
}

/**
 * Start connecting an app to an agent's own identity. The agent record is
 * refetched too: Core adds the new account to a limited agent's allowlist.
 */
export function useInitiateAgentComposioConnection(agentId: string | null) {
	const target = useTarget();
	const queryClient = useQueryClient();
	return useMutation<
		ComposioConnectInitiate,
		Error,
		{ accessLevel: ConnectionAccessLevel; toolkit: string }
	>({
		mutationFn: ({ accessLevel, toolkit }) =>
			initiateAgentComposioConnection(
				target,
				agentId ?? "",
				toolkit,
				accessLevel
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: agentComposioConnectionsKey(target, agentId),
			});
			queryClient.invalidateQueries({ queryKey: ["agents"] });
		},
	});
}

/** Disconnect an app from an agent's own identity. */
export function useDisconnectAgentComposioConnection(agentId: string | null) {
	const target = useTarget();
	const queryClient = useQueryClient();
	return useMutation<void, Error, string>({
		mutationFn: (id) =>
			disconnectAgentComposioConnection(target, agentId ?? "", id),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: agentComposioConnectionsKey(target, agentId),
			});
			queryClient.invalidateQueries({ queryKey: ["agents"] });
		},
	});
}
