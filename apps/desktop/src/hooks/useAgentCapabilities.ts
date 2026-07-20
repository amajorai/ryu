// apps/desktop/src/hooks/useAgentCapabilities.ts
//
// Loads the active agent's effective capabilities (tools / reasoning / vision)
// so the composer and the agent edit page can render controls conditionally,
// the Jan way: a model that can't call tools shows no tools affordance, a
// non-reasoning model shows no thinking control. Cached per (node, agent); only
// fetched when an agent id is present. Every decision lives in Core
// (`GET /api/agents/:id/capabilities`).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type CapabilityOverrides,
	type CapabilityReport,
	fetchAgentCapabilities,
	setAgentCapabilities,
} from "@/src/lib/api/capabilities.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentCapabilitiesResult {
	capabilities: CapabilityReport | null;
	error: string | null;
	loading: boolean;
	saving: boolean;
	/** Persist overrides and refresh. Pass `null` for a field to reset to auto. */
	setOverrides: (overrides: CapabilityOverrides) => Promise<void>;
}

export function useAgentCapabilities(
	agentId: string | null | undefined,
	modelId?: string | null
): UseAgentCapabilitiesResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["agent-capabilities", node.url, agentId, modelId ?? null],
		[node.url, agentId, modelId]
	);

	const enabled = Boolean(agentId);
	const query = useQuery({
		queryKey,
		queryFn: () =>
			fetchAgentCapabilities(target, agentId as string, modelId ?? undefined),
		enabled,
		// Detection is static per agent binary / model file; cache aggressively
		// (an ACP probe spawns the agent subprocess) and never refetch on focus.
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: false,
	});

	const mutation = useMutation({
		mutationFn: (overrides: CapabilityOverrides) =>
			setAgentCapabilities(target, agentId as string, overrides),
		onSuccess: (report) => {
			queryClient.setQueryData(queryKey, report);
		},
	});

	const setOverrides = useCallback(
		async (overrides: CapabilityOverrides) => {
			if (!agentId) {
				return;
			}
			await mutation.mutateAsync(overrides);
		},
		[agentId, mutation]
	);

	return {
		capabilities: query.data ?? null,
		loading: enabled && query.isLoading,
		error: (query.error as Error | null)?.message ?? null,
		setOverrides,
		saving: mutation.isPending,
	};
}
