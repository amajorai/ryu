// apps/desktop/src/hooks/usePaidKeyNotice.ts
//
// Tells the user, once per conversation, that a paid API key now serves it
// because the provider's subscription accounts ran out. Core keeps the notice
// and hands it out once (`POST /api/conversations/{id}/paid-key-notice`).
//
// Nothing is asked while "use API keys when subscription accounts run out" is
// off, which is the default: the setting is read at most once per five
// minutes, and only while it is on is the notice collected.

import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	claimPaidKeyNotice,
	fetchProviderCredentials,
	providerCredentialKeys,
} from "@/src/lib/api/provider-credentials.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** The subscription provider Core can switch to an API key. */
const FALLBACK_PROVIDER_ID = "claude-pro-max";
const FIVE_MINUTES_MS = 1000 * 60 * 5;
const COLLECT_EVERY_MS = 1000 * 30;

export function usePaidKeyNotice(
	conversationId: string | null,
	active = true
): void {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const tl = useLiteralMessages();
	const watching = active && Boolean(conversationId);
	const settings = useQuery({
		queryKey: providerCredentialKeys.list(target, FALLBACK_PROVIDER_ID),
		queryFn: ({ signal }) =>
			fetchProviderCredentials(target, FALLBACK_PROVIDER_ID, signal),
		enabled: watching,
		subscribed: watching,
		staleTime: FIVE_MINUTES_MS,
		// Older Core has no such route; then there is nothing to tell.
		retry: false,
	});
	const collecting = watching && settings.data?.apiKeyFallback.enabled === true;
	const { data: notice } = useQuery({
		queryKey: [
			"paid-key-notice",
			target.url,
			target.token,
			target.userJwt ?? null,
			conversationId,
		],
		queryFn: ({ signal }) =>
			claimPaidKeyNotice(target, conversationId ?? "", signal),
		enabled: collecting,
		subscribed: collecting,
		staleTime: 0,
		gcTime: 0,
		refetchInterval: COLLECT_EVERY_MS,
		refetchOnWindowFocus: true,
		retry: false,
	});
	const told = useRef(new Set<string>());
	useEffect(() => {
		if (!(notice && conversationId) || told.current.has(conversationId)) {
			return;
		}
		told.current.add(conversationId);
		sileo.warning({
			title: tl("A paid API key is now in use"),
			description: tl(
				"Your subscription accounts ran out, so this conversation now uses the API key {label}. API keys are billed per request.",
				{ label: notice.label }
			),
		});
	}, [notice, conversationId, tl]);
}
