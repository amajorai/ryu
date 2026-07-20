// apps/desktop/src/hooks/useComposioCatalog.ts
//
// TanStack Query hooks backing the agent editor's Composio pickers. Status tells
// the editor whether a key is configured; toolkits/actions/triggers are browsed
// on demand (a toolkit's actions are only fetched once the user expands it). All
// data decisions live in Core; these are thin cached fetchers.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ComposioAction,
	type ComposioConnectInitiate,
	type ComposioConnection,
	type ComposioStatus,
	type ComposioToolkit,
	type ComposioTrigger,
	fetchComposioActions,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	fetchComposioTriggers,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import { useActiveNode } from "./useActiveNode.ts";

function useTarget(): ApiTarget {
	const activeNode = useActiveNode();
	return { url: activeNode.url, token: activeNode.token ?? null };
}

/** Whether a Composio key is configured on the active node. */
export function useComposioStatus() {
	const target = useTarget();
	return useQuery<ComposioStatus>({
		queryKey: ["composio", "status", target.url],
		queryFn: () => fetchComposioStatus(target),
		staleTime: 30_000,
	});
}

/** Browse the user's Composio toolkits (only when `enabled`). */
export function useComposioToolkits(enabled: boolean) {
	const target = useTarget();
	return useQuery<ComposioToolkit[]>({
		queryKey: ["composio", "toolkits", target.url],
		queryFn: () => fetchComposioToolkits(target),
		enabled,
		staleTime: 5 * 60_000,
	});
}

/** List a toolkit's actions (only when a toolkit is selected). */
export function useComposioActions(toolkit: string | null, query = "") {
	const target = useTarget();
	return useQuery<ComposioAction[]>({
		queryKey: ["composio", "actions", target.url, toolkit ?? "", query],
		queryFn: () => fetchComposioActions(target, toolkit ?? "", query),
		enabled: Boolean(toolkit),
		staleTime: 5 * 60_000,
	});
}

/** List a toolkit's trigger types (only when a toolkit is selected). */
export function useComposioTriggers(toolkit: string | null) {
	const target = useTarget();
	return useQuery<ComposioTrigger[]>({
		queryKey: ["composio", "triggers", target.url, toolkit ?? ""],
		queryFn: () => fetchComposioTriggers(target, toolkit ?? ""),
		enabled: Boolean(toolkit),
		staleTime: 5 * 60_000,
	});
}

/**
 * The user's Composio connections (Marketplace → Connections, and the agent
 * editor's "pick from connected" picker). Optionally filtered to one toolkit.
 * Refetches on window focus so a connection authorized in the browser shows as
 * active when the user returns.
 */
export function useComposioConnections(toolkit = "", enabled = true) {
	const target = useTarget();
	return useQuery<ComposioConnection[]>({
		queryKey: ["composio", "connections", target.url, toolkit],
		queryFn: () => fetchComposioConnections(target, toolkit),
		enabled,
		staleTime: 15_000,
		refetchOnWindowFocus: true,
	});
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
	return useMutation<ComposioConnectInitiate, Error, string>({
		mutationFn: (toolkit: string) =>
			initiateComposioConnection(target, toolkit),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["composio", "connections", target.url],
			});
		},
	});
}
