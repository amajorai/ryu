// Live usage for every saved Ryu provider subscription account.
//
// Rows come from Core's subscriptions snapshot (`useSubscriptions`), which owns
// which providers and accounts exist, which of them can report usage, and the
// probe rules: Core never asks the vendor for an account that needs a new
// sign-in, is turned off in the pool, or cannot report usage, so this hook no
// longer probes those itself. One request per node replaces the per-account
// fan-out; the query key carries the node and credentials, so switching nodes
// cannot reuse another machine's snapshot.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";
import {
	fetchSubscriptionsSnapshot,
	type SubscriptionAccount,
	type UsageSnapshot,
	usageSnapshotFromReading,
} from "@/src/lib/api/usage.ts";
import { useActiveNode } from "./useActiveNode.ts";
import {
	seedAccountReadings,
	subscriptionsSnapshotKey,
	useSubscriptions,
} from "./useSubscriptions.ts";

export interface SubscriptionUsageAccount {
	accountId: string;
	accountLabel: string;
	active: boolean;
	category: string;
	error: string | null;
	gatewayActive: boolean;
	kind: string;
	loading: boolean;
	providerId: string;
	providerLabel: string;
	snapshot: UsageSnapshot | null;
}

export interface UseSubscriptionUsageResult {
	accounts: SubscriptionUsageAccount[];
	refresh: () => void;
	refreshing: boolean;
}

/** Whether the catalog holds any saved login a subscription row could show. */
function hasSubscriptionAccounts(catalog: PiCatalog | null): boolean {
	return (
		catalog?.providers.some(
			(provider) =>
				provider.authKind === "subscription" &&
				!provider.managed &&
				(provider.accounts?.length ?? 0) > 0
		) ?? false
	);
}

/**
 * The bar model for an account Core deliberately did not read, so the
 * dashboard says why instead of "no response yet".
 */
function unreadSnapshot(
	providerId: string,
	account: SubscriptionAccount
): UsageSnapshot | null {
	const reason =
		account.state === "needs_reauth"
			? "token_expired"
			: account.state === "unsupported"
				? "unsupported"
				: null;
	if (!reason) {
		return null;
	}
	return {
		agentId: providerId,
		engine: "",
		available: false,
		plan: null,
		reason,
		windows: [],
		meters: [],
		extraUsageUsd: null,
		retryAfterSeconds: null,
		providerId,
		accountId: account.accountId,
	};
}

export function useSubscriptionUsage(
	catalog: PiCatalog | null
): UseSubscriptionUsageResult {
	const active = useIsActiveTab();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	// The catalog only gates the request: a node with no saved subscription
	// login costs nothing.
	const query = useSubscriptions({
		enabled: active && hasSubscriptionAccounts(catalog),
		target,
		usage: "refresh",
	});

	const error =
		query.error instanceof Error
			? query.error.message
			: query.error
				? "Unable to refresh subscription usage."
				: null;
	const accounts = useMemo(() => {
		const rows: SubscriptionUsageAccount[] = [];
		for (const provider of query.data?.providers ?? []) {
			if (provider.kind !== "subscription" || provider.managed) {
				continue;
			}
			for (const account of provider.accounts) {
				rows.push({
					accountId: account.accountId,
					accountLabel: account.label ?? account.accountId,
					active: account.active,
					category: provider.label.replace(/\s*\([^)]*\)\s*$/, "").trim(),
					gatewayActive: account.gatewayActive,
					kind: account.kind,
					loading: query.isLoading || account.state === "pending",
					providerId: provider.providerId,
					providerLabel: provider.label,
					snapshot: account.usage
						? usageSnapshotFromReading(account.usage)
						: unreadSnapshot(provider.providerId, account),
					error,
				});
			}
		}
		return rows;
	}, [error, query.data, query.isLoading]);

	// A manual refresh always reads the vendor, like the old per-account
	// re-fetch did; the result replaces the cached snapshot.
	const refresh = useCallback(() => {
		void queryClient
			.fetchQuery({
				queryKey: subscriptionsSnapshotKey(target, undefined, "refresh"),
				queryFn: async ({ signal }) => {
					const snapshot = await fetchSubscriptionsSnapshot(target, {
						usage: "force",
						signal,
					});
					seedAccountReadings(queryClient, target, snapshot);
					return snapshot;
				},
				staleTime: 0,
			})
			.catch(() => undefined);
	}, [queryClient, target]);

	return {
		accounts,
		refresh,
		refreshing: query.isFetching,
	};
}
