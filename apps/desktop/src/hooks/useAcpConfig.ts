// apps/desktop/src/hooks/useAcpConfig.ts
//
// Loads the active agent's ACP session config (permission modes / reasoning
// effort / models) so the composer can render per-agent pickers, exactly the
// data-driven way Zed does it. Cached per (node, agent); only fetched when an
// agent id is present. Non-ACP agents return all-null and simply show no
// pickers. Every decision lives in Core (`/api/agents/:id/acp-config`).

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type AcpConfig, fetchAcpConfig } from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAcpConfigResult {
	config: AcpConfig | null;
	error: string | null;
	loading: boolean;
}

export function useAcpConfig(
	agentId: string | null | undefined,
	/**
	 * The config-option picks the probe should apply first. Pass the agent's
	 * current model pick: an agent's option SET can depend on it (opencode offers
	 * its reasoning `effort` option only while the model has effort levels), so
	 * probing without it reports a real but incomplete set.
	 */
	selections?: Record<string, string> | null
): UseAcpConfigResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	// Sorted + stringified so the key is by VALUE: a fresh object literal from the
	// caller's render must not look like a new query.
	const selectionKey = useMemo(
		() =>
			JSON.stringify(
				Object.entries(selections ?? {}).sort(([a], [b]) => a.localeCompare(b))
			),
		[selections]
	);

	const enabled = Boolean(agentId);
	const query = useQuery({
		queryKey: ["acp-config", node.url, agentId, selectionKey],
		queryFn: () => {
			if (!agentId) {
				throw new Error("Select an agent before requesting ACP configuration.");
			}
			return fetchAcpConfig(target, agentId, selections);
		},
		enabled,
		// Switching model changes the key, and a probe of the new selection can
		// take seconds. Keep the previous answer on screen while it runs so the
		// pickers the user is looking at do not blank out mid-interaction.
		placeholderData: (previous) => previous,
		// The advertised set is static per agent binary; cache aggressively and
		// don't refetch on focus (probing spawns the agent subprocess).
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		// A probe can fail transiently: the FIRST spawn of a large agent binary is
		// cold (npx + hundreds of MB to mmap), and some agents (Codex) only finish
		// `session/new` once their model backend is reachable. A single failure with
		// no retry left the composer's per-agent model/approval/thinking pickers
		// permanently empty until a manual reload — the exact "Codex has no pickers,
		// Claude does" gap. Core now bounds each probe (30s) so a retry is cheap and
		// self-heals once the binary is warm and the backend is up.
		retry: 2,
		retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10_000),
	});

	return {
		config: query.data ?? null,
		loading: enabled && query.isLoading,
		error: query.error?.message ?? null,
	};
}
