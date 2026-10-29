// apps/desktop/src/hooks/useSubscriptions.ts
//
// The owner-only subscriptions primitive: every subscription provider, its saved
// accounts, Core's capability flags and (unless `usage: "none"`) one usage
// reading per account. Every desktop surface that needs "which accounts does
// this provider have and how much is left" reads it from here instead of
// rebuilding the list from the Pi catalog and a per-provider id allowlist.
//
// Keys are scoped by node + credentials (`subscriptionQueryKeys`), so a node or
// sign-in switch never serves another node's accounts. Account labels may be
// email addresses: they live in the query cache for display only and are never
// persisted.

import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchSubscriptionsSnapshot,
	type SubscriptionsSnapshot,
	type SubscriptionUsageMode,
	subscriptionQueryKeys,
} from "@/src/lib/api/usage.ts";
import { useActiveNode } from "./useActiveNode.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;

export interface UseSubscriptionsOptions {
	/** Defaults to true; false keeps the query idle and unsubscribed. */
	enabled?: boolean;
	providerId?: string;
	/** Node to read; defaults to the tab's active node. */
	target?: ApiTarget;
	/**
	 * `none` lists accounts only (cheap, no vendor I/O); `cached` never waits on
	 * a vendor; `refresh` (default) reads accounts whose reading is stale.
	 */
	usage?: Exclude<SubscriptionUsageMode, "force">;
}

/** The query key for one snapshot read; the mode is part of the key. */
export function subscriptionsSnapshotKey(
	target: ApiTarget,
	providerId: string | undefined,
	usage: SubscriptionUsageMode
) {
	return [
		...subscriptionQueryKeys.snapshot(target, providerId),
		usage,
	] as const;
}

/**
 * Copy each account's reading from a snapshot into the per-account reading
 * cache, so a badge or the stats strip mounted afterwards does not ask again.
 */
export function seedAccountReadings(
	queryClient: QueryClient,
	target: ApiTarget,
	snapshot: SubscriptionsSnapshot
): void {
	for (const provider of snapshot.providers) {
		for (const account of provider.accounts) {
			if (account.usage) {
				queryClient.setQueryData(
					subscriptionQueryKeys.reading(
						target,
						provider.providerId,
						account.accountId
					),
					account.usage
				);
			}
		}
	}
}

/**
 * The subscriptions snapshot for the active node (or `target`). `data` is
 * `undefined` until the first load; errors stay on the query so callers can
 * degrade to "no accounts".
 */
export function useSubscriptions(options: UseSubscriptionsOptions = {}) {
	const node = useActiveNode();
	const nodeTarget = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const target = options.target ?? nodeTarget;
	const usage = options.usage ?? "refresh";
	const enabled = options.enabled ?? true;
	const queryClient = useQueryClient();
	return useQuery({
		queryKey: subscriptionsSnapshotKey(target, options.providerId, usage),
		queryFn: async ({ signal }) => {
			const snapshot = await fetchSubscriptionsSnapshot(target, {
				providerId: options.providerId,
				usage,
				signal,
			});
			seedAccountReadings(queryClient, target, snapshot);
			return snapshot;
		},
		enabled,
		subscribed: enabled,
		staleTime: FIVE_MINUTES_MS,
		refetchInterval: usage === "none" ? false : FIVE_MINUTES_MS,
		refetchOnWindowFocus: usage !== "none",
	});
}
