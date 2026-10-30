"use client";

import type { useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import type { UniversalPickerData } from "@/components/agent-elements/input/universal-picker-body.tsx";
import type { useProviderQueryScope } from "@/src/hooks/provider-query-scope.ts";
import type { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	removeAgentAccount,
	switchAgentAccount,
} from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type PiCatalog,
	removeProviderAccount,
	switchProviderAccount,
} from "@/src/lib/api/pi-config.ts";

export interface BuildAccountHandlersParams {
	applyCatalog: (catalog: PiCatalog) => void;
	node: ReturnType<typeof useActiveNode>;
	providerScope: ReturnType<typeof useProviderQueryScope>;
	queryClient: ReturnType<typeof useQueryClient>;
}

export function buildAccountHandlers({
	applyCatalog,
	node,
	providerScope,
	queryClient,
}: BuildAccountHandlersParams): Pick<
	UniversalPickerData,
	| "onRemoveAgentAccount"
	| "onRemoveProviderAccount"
	| "onSwitchAgentAccount"
	| "onSwitchProviderAccount"
> {
	return {
		// ── Account switching (multi-account, sealed vault) ──
		//
		// Switch/remove fold the refreshed catalog straight into the cache
		// (the route returns it) so the picker's `configured`/`accounts`
		// state flips without a second round trip. Agent accounts live in a
		// separate query keyed by agent id, so those get invalidated instead.
		onSwitchProviderAccount: (
			providerId,
			accountId,
			accountTarget = "self"
		) => {
			providerScope
				.write(() =>
					switchProviderAccount(
						providerScope.target,
						providerId,
						accountId,
						accountTarget
					)
				)
				.then(applyCatalog)
				.catch((error) => {
					sileo.error({
						title:
							error instanceof Error
								? error.message
								: "Could not switch account",
					});
				});
		},
		onRemoveProviderAccount: (providerId, accountId) => {
			providerScope
				.write(() =>
					removeProviderAccount(providerScope.target, providerId, accountId)
				)
				.then(applyCatalog)
				.catch((error) => {
					sileo.error({
						title:
							error instanceof Error
								? error.message
								: "Could not remove account",
					});
				});
		},
		onSwitchAgentAccount: (agentId, accountId, provider) => {
			switchAgentAccount(toTarget(node), agentId, { accountId, provider })
				.then(({ reauthenticate }) => {
					// Core could not swap this agent's own login in place; the
					// active account is unchanged until the user signs in again.
					if (reauthenticate) {
						sileo.info({
							title: "Sign in again to use this account",
							description:
								"This agent keeps its own login. Run its sign-in again to switch accounts.",
						});
					}
					queryClient
						.invalidateQueries({
							queryKey: ["agent-accounts", node.url, agentId],
						})
						.catch(() => undefined);
				})
				.catch((error) => {
					sileo.error({
						title:
							error instanceof Error
								? error.message
								: "Could not switch account",
					});
				});
		},
		onRemoveAgentAccount: (agentId, accountId) => {
			removeAgentAccount(toTarget(node), agentId, accountId)
				.then(() => {
					queryClient
						.invalidateQueries({
							queryKey: ["agent-accounts", node.url, agentId],
						})
						.catch(() => undefined);
				})
				.catch((error) => {
					sileo.error({
						title:
							error instanceof Error
								? error.message
								: "Could not remove account",
					});
				});
		},
	};
}
