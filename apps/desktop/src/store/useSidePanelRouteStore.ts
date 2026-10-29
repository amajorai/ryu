// apps/desktop/src/store/useSidePanelRouteStore.ts
//
// The programmatic seam for raising a PAGE in the workspace's right dock.
//
// The dock can host any main-tab route (`dock-panels.ts`'s `route:` kind), but
// the surfaces that ASK for one live all over the shell — a "+" menu, a command,
// a tool result rendered in the chat — and none of them own the dock. So they
// queue a request here and `ChatPage` hands it to `WorkspacePanels`, exactly the
// nonce-carrying request shape the artifact / inspector / subagent panels already
// use: the nonce changes on every call so asking twice re-focuses the tab rather
// than being swallowed as "same value, no re-render".
//
// TWO entry points, and the split is the security boundary:
//
//   * `openPage(key)` — takes a PAGE KEY from the shared `PAGE_ROUTES`
//     vocabulary, never a path. This is the one an untrusted producer may reach:
//     an agent, a tool result, an app. The same reasoning as the `initialSubmit`
//     note in `TabsContext.tsx` and the confirm dialog on `ryu://` links — text
//     an agent chose is attacker-influenceable, so it selects from a curated list
//     instead of naming a destination.
//   * `openPath(path)` — takes a raw route, for USER-INITIATED affordances only
//     (a menu row the user clicked). Still guarded by `isDockableRoutePath`.

import { create } from "zustand";
import {
	isDockableRoutePath,
	routeTabKind,
} from "@/src/components/panels/dock-panels.ts";
import { pageLabel, pageRoute } from "@/src/lib/page-routes.ts";

/** A queued request to show a page in the right dock. */
export interface SidePanelRouteRequest {
	/** The `route:<path>` dock tab kind to open (or re-focus). */
	kind: ReturnType<typeof routeTabKind>;
	/** Tab label. */
	label: string;
	/** Bumped per request so a repeat of the same page still re-focuses. */
	nonce: number;
}

interface SidePanelRouteState {
	/** Drop the pending request once the dock has consumed it. */
	clear: () => void;
	/**
	 * Show the page named by an allowlisted key. Returns false (and does nothing)
	 * for a key outside {@link PAGE_ROUTES} — the refusal an untrusted caller hits.
	 */
	openPage: (page: string) => boolean;
	/**
	 * Show an arbitrary tab route. USER-INITIATED callers only; anything
	 * system-controlled goes through {@link openPage}.
	 */
	openPath: (path: string, label?: string) => boolean;
	pending: SidePanelRouteRequest | null;
}

export const useSidePanelRouteStore = create<SidePanelRouteState>(
	(set, get) => ({
		pending: null,

		openPage: (page) => {
			const path = pageRoute(page);
			if (!path) {
				return false;
			}
			return get().openPath(path, pageLabel(page));
		},

		openPath: (path, label) => {
			if (!isDockableRoutePath(path)) {
				return false;
			}
			set((state) => ({
				pending: {
					kind: routeTabKind(path),
					label: label ?? path,
					nonce: (state.pending?.nonce ?? 0) + 1,
				},
			}));
			return true;
		},

		clear: () => set({ pending: null }),
	})
);
