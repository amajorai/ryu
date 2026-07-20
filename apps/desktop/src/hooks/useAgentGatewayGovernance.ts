// apps/desktop/src/hooks/useAgentGatewayGovernance.ts
//
// Loads the gateway-routing preference snapshot for the active node so the
// agents sidebar can badge which agents traverse the Ryu gateway.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	type AgentGatewayGovernanceSnapshot,
	fetchAgentGatewayGovernanceSnapshot,
	isAgentGatewayGoverned,
} from "@/src/lib/agent-gateway.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentGatewayGovernanceResult {
	isGoverned: (agent: AgentSummary) => boolean;
	loading: boolean;
	snapshot: AgentGatewayGovernanceSnapshot | null;
}

export function useAgentGatewayGovernance(): UseAgentGatewayGovernanceResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);

	const query = useQuery({
		queryKey: ["agent-gateway-governance", node.url],
		queryFn: () => fetchAgentGatewayGovernanceSnapshot(target),
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});

	const snapshot = query.data ?? null;

	const isGoverned = useMemo(
		() => (agent: AgentSummary) => isAgentGatewayGoverned(agent, snapshot),
		[snapshot]
	);

	return {
		snapshot,
		loading: query.isLoading,
		isGoverned,
	};
}
