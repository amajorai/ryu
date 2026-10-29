// apps/desktop/src/hooks/useAgentUpdate.ts
//
// Per-agent "check for updates" for the Agents page, mirroring the Engines page
// (`useEngines` + `hasEngineUpdate`). One instance backs one agent row: it
// checks the version of the npm package behind the agent and offers an in-place
// update. The check is cached per (node, agent) and stays fresh for a few
// minutes so scrolling the list doesn't hammer npm; the update mutation
// invalidates the check on success so the row reflects the new version. Every
// decision lives in Core (`/api/agents/:id/{update-check,update}`).

import {
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AgentUpdateCheck,
	type AgentUpdateResult,
	fetchAgentUpdateCheck,
	runAgentUpdate,
} from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";

/** How long a version check stays fresh before a background refetch. */
const CHECK_STALE_MS = 5 * 60 * 1000;

export interface UseAgentUpdateResult {
	check: AgentUpdateCheck | null;
	error: string | null;
	loading: boolean;
	/** Run the update; resolves with Core's result (updated / installedVersion / error). */
	update: () => Promise<AgentUpdateResult>;
	updating: boolean;
}

export function useAgentUpdate(
	agentId: string | null | undefined,
	enabled = true
): UseAgentUpdateResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();

	const active = Boolean(agentId) && enabled;
	const query = useQuery({
		queryKey: ["agent-update", node.url, agentId],
		queryFn:
			agentId === null || agentId === undefined
				? skipToken
				: () => fetchAgentUpdateCheck(target, agentId),
		enabled: active,
		staleTime: CHECK_STALE_MS,
		refetchOnWindowFocus: false,
	});

	const mutation = useMutation({
		mutationFn: () => {
			if (agentId === null || agentId === undefined) {
				throw new Error(
					"Select an agent before checking or installing an update."
				);
			}
			return runAgentUpdate(target, agentId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["agent-update", node.url, agentId],
			});
			// The Downloads panel derives its agent rows from the agents catalog,
			// not from this check — refresh both so one update clears both surfaces.
			queryClient.invalidateQueries({
				queryKey: ["agents", "catalog", node.url],
			});
		},
	});

	const update = useCallback(() => mutation.mutateAsync(), [mutation]);

	return {
		check: query.data ?? null,
		loading: active && query.isLoading,
		error: query.error?.message ?? null,
		update,
		updating: mutation.isPending,
	};
}
