// apps/desktop/src/hooks/useProviderAccountUsage.ts
//
// One saved Ryu provider account's usage reading
// (`GET /api/usage/subscriptions/{provider}/reading`), and which provider and
// account a conversation runs on. Mirrors `useAgentUsage`: a 5-minute
// stale-while-revalidate poll, never per turn. Core serves a fresh cached
// reading without calling the vendor, so N mounted badges for one account cost
// one request per five minutes.
//
// `accountId: null` reads the provider's ACTIVE account; the reading's
// `accountId` says which one that was. An explicit id never falls back to the
// active account: an unknown id reads `account_not_found`.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type ConversationProviderAccount,
	fetchConversationProviderAccount,
	fetchProviderUsageReading,
	type ProviderUsageReading,
	subscriptionQueryKeys,
} from "@/src/lib/api/usage.ts";
import { useActiveNode } from "./useActiveNode.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;

/**
 * The reading for `providerId`/`accountId`, or `null` until the first load or
 * while disabled (`providerId` null or `active` false).
 */
export function useProviderAccountUsage(
	providerId: string | null,
	accountId: string | null,
	active = true
): ProviderUsageReading | null {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const enabled = active && Boolean(providerId);
	const { data } = useQuery({
		queryKey: subscriptionQueryKeys.reading(
			target,
			providerId ?? "",
			accountId
		),
		queryFn: ({ signal }) =>
			fetchProviderUsageReading(target, {
				providerId: providerId ?? "",
				accountId,
				signal,
			}),
		enabled,
		subscribed: enabled,
		staleTime: FIVE_MINUTES_MS,
		refetchInterval: FIVE_MINUTES_MS,
		refetchOnWindowFocus: true,
	});
	return data ?? null;
}

/**
 * Which subscription provider and saved account `conversationId` runs on, or
 * `null` while unknown. Read-only in Core: it never creates a binding.
 */
export function useConversationProviderAccount(
	conversationId: string | null,
	active = true
): ConversationProviderAccount | null {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const enabled = active && Boolean(conversationId);
	const { data } = useQuery({
		queryKey: [
			"conversation-provider-account",
			target.url,
			target.token,
			target.userJwt ?? null,
			conversationId,
		],
		queryFn: ({ signal }) =>
			fetchConversationProviderAccount(target, conversationId ?? "", signal),
		enabled,
		subscribed: enabled,
		staleTime: FIVE_MINUTES_MS,
		refetchInterval: FIVE_MINUTES_MS,
		refetchOnWindowFocus: true,
		// Older Core has no such route; a miss simply keeps the agent-level strip.
		retry: false,
	});
	return data ?? null;
}
