// apps/desktop/src/hooks/useAgentUsage.ts
//
// The active chat agent's subscription usage snapshot (5h + weekly rate-limit
// windows). Backs the chat "usage bar". Polled on a 5-minute cadence
// (stale-while-revalidate, like CodexBar / openusage) — never per chat turn —
// and only enabled for agents that could plausibly have a subscription window,
// so unsupported agents cost nothing.
//
// An ACP agent (`acp:*`) reads `/api/agents/:id/usage`. A Ryu subscription
// provider id (`claude-pro-max`, `chatgpt`, …) is the shared per-account reading
// instead (`useProviderAccountUsage`, the provider's active account), so the
// picker, settings and chat all show the same cached number for one account.
// Whether an id is such a provider comes from Core's subscriptions listing, not
// from a client-side id list.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import {
	fetchAgentUsage,
	supportsUsage,
	usageSnapshotFromReading,
} from "@/src/lib/api/usage.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useProviderAccountUsage } from "./useProviderAccountUsage.ts";
import { useSubscriptions } from "./useSubscriptions.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;

/**
 * The usage snapshot for `agentId`, or `null` until the first load (or when the
 * agent has no readable subscription window). Refetches every 5 minutes while
 * active; stale data stays visible during a refetch.
 */
export function useAgentUsage(
	agentId: string | null,
	active = true
): UsageSnapshot | null {
	const node = useActiveNode();
	const candidate = active && supportsUsage(agentId);
	// ACP agents are never Ryu provider ids, so they skip the listing entirely.
	const mayBeProvider = candidate && !agentId?.startsWith("acp:");
	const listing = useSubscriptions({ enabled: mayBeProvider, usage: "none" });
	const provider = mayBeProvider
		? listing.data?.providers.find(
				(entry) => entry.providerId === agentId && entry.kind === "subscription"
			)
		: undefined;
	const providerUsage = Boolean(provider?.capabilities.accountUsage);
	// Wait for the listing before choosing a route; a failed listing (older
	// Core) falls back to the agent route, which Core still answers.
	const settled = !mayBeProvider || listing.isSuccess || listing.isError;
	const reading = useProviderAccountUsage(
		providerUsage ? (agentId ?? null) : null,
		null,
		candidate && providerUsage
	);
	const agentEnabled = candidate && settled && !provider;
	const { data } = useQuery({
		queryKey: [
			"agent-usage",
			node.url,
			node.token ?? null,
			node.userJwt ?? null,
			agentId,
		],
		queryFn: ({ signal }) =>
			fetchAgentUsage(
				{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
				agentId ?? "",
				signal
			),
		enabled: agentEnabled,
		subscribed: agentEnabled,
		staleTime: FIVE_MINUTES_MS,
		refetchInterval: FIVE_MINUTES_MS,
		refetchOnWindowFocus: true,
	});
	const providerSnapshot = useMemo(
		() => (reading ? usageSnapshotFromReading(reading) : null),
		[reading]
	);
	if (provider) {
		return providerSnapshot;
	}
	return data ?? null;
}
