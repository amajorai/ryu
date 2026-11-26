"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	fetchProviderCredentials,
	providerCredentialKeys,
	setApiKeyFallback,
} from "@/src/lib/api/provider-credentials.ts";
import { ApiKeyFallbackSetting } from "./ApiKeyFallbackSetting.tsx";
import { OAuthAccountPoolControls } from "./OAuthAccountPoolControls.tsx";

/** Display names of the providers whose API keys can take over. */
const KEY_PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic" };

/**
 * A provider's ordered credential list with its routing controls, and, where
 * Core can switch the provider to an API key, the fallback setting. Renders
 * nothing for a provider with no routable account.
 */
export function ProviderCredentialRouting({
	provider,
}: {
	provider: PiProvider;
}) {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const tl = useLiteralMessages();
	const routing = provider.accountRouting ?? null;
	const accounts = useMemo(
		() =>
			provider.accounts?.filter((account) =>
				routing?.credentialKinds.some((kind) => kind === account.kind)
			) ?? [],
		[provider.accounts, routing]
	);
	const shown = routing !== null && accounts.length > 0;
	const queryKey = providerCredentialKeys.list(target, provider.id);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			fetchProviderCredentials(target, provider.id, signal),
		enabled: shown,
		// Older Core has no such route; the list then shows without hints.
		retry: false,
	});
	// A key that was added, renamed or removed changes the hints.
	const accountsKey = accounts
		.map((account) => `${account.accountId}:${account.label}`)
		.join("\u0000");
	const seenAccountsKey = useRef(accountsKey);
	useEffect(() => {
		if (seenAccountsKey.current === accountsKey) {
			return;
		}
		seenAccountsKey.current = accountsKey;
		queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
	});
	const save = useMutation({
		mutationFn: (enabled: boolean) =>
			setApiKeyFallback(target, provider.id, enabled),
		onSuccess: (saved) => {
			queryClient.setQueryData(queryKey, saved);
			sileo.success({
				title: saved.apiKeyFallback.enabled
					? tl("API keys will take over when subscription accounts run out")
					: tl("API keys will not be used for this provider"),
			});
		},
		onError: (error) => {
			sileo.error({
				title: tl("Could not save the API key setting"),
				description:
					error instanceof Error
						? error.message
						: tl("Core rejected the change."),
			});
		},
	});
	const hints = useMemo(() => {
		const byId: Record<string, string> = {};
		for (const credential of query.data?.credentials ?? []) {
			if (credential.hint) {
				byId[credential.accountId] = credential.hint;
			}
		}
		return byId;
	}, [query.data]);

	if (!(routing && shown)) {
		return null;
	}
	const fallback = query.data?.apiKeyFallback;
	return (
		<>
			<OAuthAccountPoolControls
				accounts={accounts}
				capabilities={routing}
				hints={hints}
				providerId={provider.id}
			/>
			{fallback?.supported ? (
				<ApiKeyFallbackSetting
					busy={save.isPending}
					fallback={fallback}
					keyProviderLabel={
						KEY_PROVIDER_LABELS[fallback.keyProviderId ?? ""] ??
						fallback.keyProviderId ??
						""
					}
					onChange={(enabled) => save.mutate(enabled)}
				/>
			) : null}
		</>
	);
}
