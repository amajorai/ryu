// apps/desktop/src/hooks/useAgentCapabilities.ts
//
// Loads the active agent's effective capabilities (tools / reasoning / vision)
// so the composer and the agent edit page can render controls conditionally,
// the Jan way: a model that can't call tools shows no tools affordance, a
// non-reasoning model shows no thinking control. Cached per (node, agent); only
// fetched when an agent id is present. Every decision lives in Core
// (`GET /api/agents/:id/capabilities`).

import {
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
	modelId?: string | null,
	/**
	 * The agent's current ACP config-option picks. Must be the SAME set passed to
	 * `useAcpConfig`: `reasoning` is derived from the same probe, so probing them
	 * apart lets this hook report "no reasoning" for a model whose reasoning
	 * option the composer is simultaneously being told about — and the composer
	 * resolves that contradiction by hiding the option.
	 */
	acpSelections?: Record<string, string> | null
): UseAgentCapabilitiesResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();
	// By value, not by object identity — see `useAcpConfig`.
	const selectionKey = useMemo(
		() =>
			JSON.stringify(
				Object.entries(acpSelections ?? {}).sort(([a], [b]) =>
					a.localeCompare(b)
				)
			),
		[acpSelections]
	);
	const queryKey = useMemo(
		() => [
			"agent-capabilities",
			node.url,
			agentId,
			modelId ?? null,
			selectionKey,
		],
		[node.url, agentId, modelId, selectionKey]
	);

	const enabled = Boolean(agentId);
	const query = useQuery({
		queryKey,
		queryFn:
			agentId === null || agentId === undefined
				? skipToken
				: () =>
						fetchAgentCapabilities(
							target,
							agentId,
							modelId ?? undefined,
							acpSelections
						),
		enabled,
		// Keep the last answer visible while a new selection is probed, so the
		// composer does not briefly treat "unknown" as "no reasoning".
		placeholderData: (previous) => previous,
		// Detection is static per agent binary / model file; cache aggressively
		// (an ACP probe spawns the agent subprocess) and never refetch on focus.
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: false,
	});

	const mutation = useMutation({
		mutationFn: (overrides: CapabilityOverrides) => {
			if (agentId === null || agentId === undefined) {
				throw new Error("Select an agent before changing capabilities.");
			}
			return setAgentCapabilities(target, agentId, overrides);
		},
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
		error: query.error?.message ?? null,
		setOverrides,
		saving: mutation.isPending,
	};
}
