// apps/desktop/src/hooks/useUsageRailSources.ts
//
// The data behind the usage rings at the side of the window: Core's
// subscriptions snapshot (provider, saved accounts, one reading each), the
// custom account pools, and the usage of each agent that reads its own CLI
// sign-in. Every read shares its query key with the surface that already made
// it (the Usage page, the pool settings, the picker), so the rings add no
// request of their own for data another surface holds.
//
// Nothing is asked while "Show usage in the sidebar" is off, and the owner
// routes are not asked on a node with no saved subscription sign-in. The bot
// product shows no rings: it has no provider or account picker and its usage
// is the plan Ryu runs for it, so a ring there would stand for nothing the
// user can act on.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	accountPoolsQueryKey,
	accountPoolsUnsupported,
	fetchAccountPools,
} from "@/src/lib/api/account-pools.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchAgentUsage,
	supportsUsage,
	type UsageSnapshot,
} from "@/src/lib/api/usage.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	buildUsageRailSources,
	type UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useAgents } from "./useAgents.ts";
import { usePiConfig } from "./usePiConfig.ts";
import { useSubscriptions } from "./useSubscriptions.ts";
import { hasSubscriptionAccounts } from "./useSubscriptionUsage.ts";
import { useUsageBarPrefs } from "./useUsageBarPrefs.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;
const POOL_READ_RETRIES = 2;

/** The usage sources of the active node, or none while the rings are off. */
export function useUsageRailSources(): UsageRailSource[] {
	const botProduct = useProductMode() === "bot";
	const enabled = useUsageBarPrefs().sidebar && !botProduct;
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const { catalog } = usePiConfig();
	const savedAccounts = enabled && hasSubscriptionAccounts(catalog);
	const subscriptions = useSubscriptions({
		enabled: savedAccounts,
		target,
		usage: "refresh",
	});
	const pools = useQuery({
		queryKey: accountPoolsQueryKey(target),
		queryFn: () => fetchAccountPools(target),
		enabled: savedAccounts,
		staleTime: FIVE_MINUTES_MS,
		// An older Core has no pool routes: one 404 settles it, the rings then
		// show the providers alone.
		retry: (failures, error) =>
			!accountPoolsUnsupported(error) && failures < POOL_READ_RETRIES,
	});

	const { agents } = useAgents();
	// The same agents the sidebar rows asked for before: installed ones whose
	// engine can report a subscription window.
	const usageAgents = useMemo(
		() =>
			enabled
				? agents.filter(
						(agent) => agent.installed !== false && supportsUsage(agent.id)
					)
				: [],
		[agents, enabled]
	);
	const snapshots = useQueries({
		queries: usageAgents.map((agent) => ({
			// The key `useAgentUsage` reads, so the picker and the rings share
			// one reading per agent.
			queryKey: [
				"agent-usage",
				node.url,
				node.token ?? null,
				node.userJwt ?? null,
				agent.id,
			],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchAgentUsage(target, agent.id, signal),
			staleTime: FIVE_MINUTES_MS,
			refetchInterval: FIVE_MINUTES_MS,
			refetchOnWindowFocus: true,
		})),
		combine: (results): (UsageSnapshot | null)[] =>
			results.map((result) => result.data ?? null),
	});

	// The pools decide which accounts a provider ring keeps, so the provider
	// rings wait for the pool read to settle instead of regrouping after it.
	const poolsSettled = pools.isSuccess || pools.isError;
	const providers = poolsSettled ? subscriptions.data?.providers : undefined;
	const poolList = pools.data?.pools;
	return useMemo(
		() =>
			enabled
				? buildUsageRailSources({
						agents: usageAgents.map((agent, index) => ({
							avatarGlyph: agent.avatarGlyph,
							avatarUrl: agent.avatarUrl,
							engine: engineForAgent(agent),
							id: agent.id,
							name: agent.name,
							snapshot: snapshots[index] ?? null,
						})),
						pools: poolList ?? [],
						providers: providers ?? [],
					})
				: [],
		[enabled, poolList, providers, snapshots, usageAgents]
	);
}
