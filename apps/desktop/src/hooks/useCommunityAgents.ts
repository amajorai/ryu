// apps/desktop/src/hooks/useCommunityAgents.ts
//
// The Agent Templates shelf of the Store's Agents tab: customized definitions
// PUBLISHED by other users (instructions + model preference + declared dependencies), as opposed to the
// ACP runtimes (Claude Code, Codex, …) that `useAgentsCatalog` browses.
//
// It reads two different servers, on purpose:
//   • BROWSE goes to the control plane (`fetchCatalog("agent")`, :3000) — that is
//     where published listings, pricing and moderation live, and it is the only
//     surface that sees them. A signed-out user still gets the list.
//   • INSTALL goes to the NODE (`POST /api/agents/published/install`, Core) —
//     Core resolves the listing through its own catalog seam, strips the
//     privilege-bearing bindings, and returns what it removed as `requires`.
//
// Install is never a client-side materialisation of the payload: the trust
// boundary for third-party agent definitions is Core's
// `AgentTemplate::sanitize_for_untrusted_install`, and routing around it (e.g.
// through `POST /api/agents/import`, which is deliberately unsanitised because it
// exists for re-importing your OWN export) would move that decision into the UI
// where it would silently drift.
//
// The money layer being unavailable (signed out, no org, network) must never
// break the Agents tab, so the browse error is reported, not thrown.

import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveUserId } from "@/lib/auth-client.ts";
import {
	installPublishedAgent,
	type PublishedAgentInstallResult,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchCatalog,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseCommunityAgentsResult {
	/** Published agent listings, newest-first as the server ranks them. */
	agents: MarketplaceCard[];
	/** Why the listing browse failed, or null. Never fatal to the tab. */
	error: string | null;
	/** Install one listing as a new local agent. Resolves with what Core stripped. */
	install: (id: string) => Promise<PublishedAgentInstallResult>;
	loading: boolean;
	/** Listing id whose install is in flight, or null. */
	pendingId: string | null;
	refresh: () => Promise<void>;
}

/** Scope an install result to the identity that Core and the marketplace saw. */
export function communityAgentInstallCacheKey(
	target: ApiTarget,
	accountId: string | null,
	id: string
): string {
	return JSON.stringify({
		accountId,
		id,
		token: target.token,
		userJwt: target.userJwt ?? null,
		url: target.url.replace(/\/$/, ""),
	});
}

/** The wire key is stable across remounts, but excludes the node bearer token. */
export function communityAgentInstallIdempotencyKey(
	target: ApiTarget,
	accountId: string | null,
	id: string
): string {
	return `community-agent-v1:${JSON.stringify({
		accountId,
		id,
		node: target.url.replace(/\/$/, ""),
	})}`;
}

export function useCommunityAgents(): UseCommunityAgentsResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;
	const accountId = getActiveUserId();

	const [agents, setAgents] = useState<MarketplaceCard[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	// This is intentionally only an in-flight deduplication map. A completed
	// install can be deleted by another mounted surface and must be installable
	// again without remounting this hook.
	const inFlightInstalls = useRef(
		new Map<string, Promise<PublishedAgentInstallResult>>()
	);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setAgents(await fetchCatalog("agent"));
			setError(null);
		} catch (e) {
			setAgents([]);
			setError(
				e instanceof Error ? e.message : "Couldn't load Agent Templates"
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	const install = useCallback(
		async (id: string) => {
			const cacheKey = communityAgentInstallCacheKey(target, accountId, id);
			const inFlight = inFlightInstalls.current.get(cacheKey);
			if (inFlight) {
				return inFlight;
			}

			const operation = (async () => {
				setPendingId(id);
				try {
					const result = await installPublishedAgent(
						{ url, token, userJwt },
						id,
						communityAgentInstallIdempotencyKey(target, accountId, id)
					);
					// Core's response is the complete install transaction. In particular,
					// requiredPlugins is disclosure for the user, never an instruction to
					// install third-party plugins. Keeping dependency handling out of this
					// path also means a dependency failure cannot turn a successful agent
					// creation into a retry that creates a duplicate agent record.
					// A published agent lands as a new local agent record, so the roster
					// every always-mounted surface reads (sidebar, picker, Library) is now
					// stale — the same refresh the runtime catalog fires on install.
					triggerAgentsRefresh();
					return result;
				} finally {
					setPendingId(null);
				}
			})();
			inFlightInstalls.current.set(cacheKey, operation);
			try {
				return await operation;
			} finally {
				if (inFlightInstalls.current.get(cacheKey) === operation) {
					inFlightInstalls.current.delete(cacheKey);
				}
			}
		},
		[url, token, accountId]
	);

	return { agents, error, install, loading, pendingId, refresh: load };
}
