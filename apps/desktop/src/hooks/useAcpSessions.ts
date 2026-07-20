// apps/desktop/src/hooks/useAcpSessions.ts
//
// Loads (and deletes) the sessions an ACP agent persists, for the agent-edit
// "Sessions" section. Most agents — including the flagship Pi — don't track
// sessions and return `unsupported`/empty, so the section self-hides; this is
// for external agents (Claude Code, Codex, …) that keep a session list. Cached
// per (node, agent); only fetched when an agent id is present. Every decision
// lives in Core (`/api/agents/:id/sessions`).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type AcpSessionList,
	deleteAcpSession,
	fetchAcpSessions,
} from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAcpSessionsResult {
	data: AcpSessionList | null;
	error: string | null;
	loading: boolean;
	/** Delete a session by id, then refetch the list. */
	remove: (sessionId: string) => Promise<{ deleted: boolean; error?: string }>;
	removing: boolean;
}

export function useAcpSessions(
	agentId: string | null | undefined
): UseAcpSessionsResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();

	const enabled = Boolean(agentId);
	const query = useQuery({
		queryKey: ["acp-sessions", node.url, agentId],
		queryFn: () => fetchAcpSessions(target, agentId as string),
		enabled,
		// Probing spawns the agent subprocess; don't refetch on focus.
		refetchOnWindowFocus: false,
	});

	const removeMutation = useMutation({
		mutationFn: (sessionId: string) =>
			deleteAcpSession(target, agentId as string, sessionId),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["acp-sessions", node.url, agentId],
			});
		},
	});

	const remove = useCallback(
		(sessionId: string) => removeMutation.mutateAsync(sessionId),
		[removeMutation]
	);

	return {
		data: query.data ?? null,
		loading: enabled && query.isLoading,
		error: (query.error as Error | null)?.message ?? null,
		remove,
		removing: removeMutation.isPending,
	};
}
