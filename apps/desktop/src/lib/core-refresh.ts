// apps/desktop/src/lib/core-refresh.ts
//
// One "refresh everything" signal for the whole app, so a user never has to hunt
// down and press a dozen per-section "Try again" buttons when Core has been down
// and comes back. It fires automatically when Core reconnects (see
// `useSystemStatus`) and manually from the single "Refresh all" action in the
// system-status popover.
//
// The app has two data-fetching worlds that don't share a refresh path:
//   1. TanStack Query hooks — reached with `queryClient.invalidateQueries()`.
//   2. Manual useState/useEffect hooks (useAgents, useMcp, useSpaces, …) that own
//      a local `reload()` the query client can't see — they subscribe to a window
//      CustomEvent instead.
// `triggerGlobalRefresh()` fans out to both at once.

import { useEffect } from "react";
import { queryClient } from "@/src/lib/query-client.ts";

/** Window event that manual `reload()` hooks listen for via {@link useCoreRefresh}. */
export const CORE_REFRESH_EVENT = "ryu:core-refresh";

/**
 * Refetch every data source in the app: all TanStack Query keys plus every manual
 * `reload()` hook subscribed via {@link useCoreRefresh}. Safe to call at any time —
 * each source's own load is idempotent, so a spurious call just re-fetches.
 */
export function triggerGlobalRefresh(): void {
	// Refetches every active TanStack Query (no key = all of them). Best-effort:
	// invalidation only fails if the client is torn down, which never happens here.
	queryClient.invalidateQueries().catch(() => {
		// Ignore — nothing actionable if a refetch can't be scheduled.
	});
	// Wakes the manual reload() hooks the query client can't reach.
	window.dispatchEvent(new CustomEvent(CORE_REFRESH_EVENT));
}

/**
 * Subscribe a manual hook's `reload`/`refresh` to the global refresh signal, so it
 * re-fetches when Core reconnects or the user hits "Refresh all". Pass the hook's
 * memoized `reload` — the subscription re-binds if its identity changes.
 */
export function useCoreRefresh(reload: () => void): void {
	useEffect(() => {
		const handler = () => reload();
		window.addEventListener(CORE_REFRESH_EVENT, handler);
		return () => window.removeEventListener(CORE_REFRESH_EVENT, handler);
	}, [reload]);
}
