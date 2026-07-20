// apps/desktop/src/hooks/useAgentUsage.ts
//
// The active chat agent's subscription usage snapshot (5h + weekly rate-limit
// windows), fetched from Core (`/api/agents/:id/usage`). Backs the chat "usage
// bar". Polled on a 5-minute cadence (stale-while-revalidate, like CodexBar /
// openusage) — never per chat turn — and only enabled for agents that could
// plausibly have a subscription window, so unsupported agents cost nothing.

import { useQuery } from "@tanstack/react-query";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import { fetchAgentUsage, supportsUsage } from "@/src/lib/api/usage.ts";
import { useActiveNode } from "./useActiveNode.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;

/**
 * The usage snapshot for `agentId`, or `null` until the first load (or when the
 * agent has no readable subscription window). Refetches every 5 minutes while
 * mounted; stale data stays visible during a refetch.
 */
export function useAgentUsage(agentId: string | null): UsageSnapshot | null {
	const node = useActiveNode();
	const enabled = supportsUsage(agentId);
	const { data } = useQuery({
		queryKey: ["agent-usage", node.url, agentId],
		queryFn: () =>
			fetchAgentUsage(
				{ url: node.url, token: node.token ?? null },
				agentId ?? ""
			),
		enabled,
		staleTime: FIVE_MINUTES_MS,
		refetchInterval: FIVE_MINUTES_MS,
		refetchOnWindowFocus: true,
	});
	return data ?? null;
}
