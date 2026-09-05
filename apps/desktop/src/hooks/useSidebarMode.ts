import { useCallback, useSyncExternalStore } from "react";

/**
 * How the left sidebar lays out its content sections.
 *
 * - "sections": every section is stacked as its own collapsible group (Agents,
 *   Workflows, Chats, …), all visible at once.
 * - "tabbed": the section labels become a row of buttons at the top; clicking a
 *   button reveals just that one section's list below, like browser tabs.
 * - "agent": BOT MODE — a focused stacked view with messaging-style agent rows
 *   and each bot's direct threads inline. Other chats remain available below the
 *   roster without a second tab strip.
 *
 * - `plugin:<pluginId>:<modeId>`: an app-registered mode from a manifest's
 *   `contributes.sidebar_modes`.
 *
 * "agent" is deliberately a MODE and not a third section: it is a preset over the
 * machinery "tabbed" already owns (`tabbedKeys`, `activeTabbedKey`, the section
 * renderer's `forceExpanded` path), so nothing downstream needs a new branch.
 *
 * The descriptors behind all four live in `layout/sidebar-modes.ts` — including
 * the built-ins, which are ordinary entries there rather than branches in the
 * renderer, so a contributed mode can do anything Bot mode does. This module
 * only owns the stored KEY.
 */
export type SidebarMode = "sections" | "tabbed" | "agent" | `plugin:${string}`;

export const SIDEBAR_MODE_KEY = "ryu:sidebar-mode";
/** The persisted key stays `agent` so existing Agent mode choices keep working. */
export const DEFAULT_SIDEBAR_MODE: SidebarMode = "agent";

const listeners = new Set<() => void>();

/**
 * The stored key, NOT a validated mode.
 *
 * Deliberately permissive: a contributed mode's validity depends on the
 * contributions feed, which this module cannot see and which has not answered on
 * first paint. Rejecting an unknown key here would silently un-choose a mode every
 * cold start. `resolveSidebarMode` does the validating, at the render site that
 * has the feed.
 */
function read(): SidebarMode {
	try {
		const stored = localStorage.getItem(SIDEBAR_MODE_KEY);
		if (
			stored === "sections" ||
			stored === "tabbed" ||
			stored === "agent" ||
			(stored?.startsWith("plugin:") ?? false)
		) {
			return stored as SidebarMode;
		}
		return DEFAULT_SIDEBAR_MODE;
	} catch {
		return DEFAULT_SIDEBAR_MODE;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === SIDEBAR_MODE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** Write the sidebar layout mode and notify every consumer. */
export function setSidebarMode(next: SidebarMode): void {
	try {
		localStorage.setItem(SIDEBAR_MODE_KEY, next);
	} catch {
		// best-effort
	}
	for (const cb of listeners) {
		cb();
	}
}

/**
 * Read + set the sidebar layout mode. Persists to localStorage and broadcasts to
 * every mounted instance (other windows via the `storage` event, same-window
 * subscribers via the listener set), mirroring useFriendlyMode.
 */
export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
	const mode = useSyncExternalStore(
		subscribe,
		read,
		() => DEFAULT_SIDEBAR_MODE
	);

	const setMode = useCallback((next: SidebarMode) => {
		setSidebarMode(next);
	}, []);

	return [mode, setMode];
}
