// apps/desktop/src/hooks/useSidebarProjectRail.ts
//
// The Discord-style project rail: an opt-in column of project icons down the
// left edge of the sidebar. Picking one narrows the sidebar to that project's
// chats; Home shows everything. Both the on/off preference and the focused
// project persist and sync across windows.

import { useCallback, useSyncExternalStore } from "react";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";

export const SIDEBAR_PROJECT_RAIL_KEY = "ryu:sidebar-project-rail";
export const SIDEBAR_RAIL_PROJECT_KEY = "ryu:sidebar-rail-project";

/** `[enabled, setEnabled]` for the project rail (default off). */
export function useSidebarProjectRailPreference(): [
	boolean,
	(enabled: boolean) => void,
] {
	return usePersistedToggle(SIDEBAR_PROJECT_RAIL_KEY, false);
}

const listeners = new Set<() => void>();

/** The project path the rail focuses, or `null` for Home. */
export function readRailProject(): string | null {
	try {
		const raw = localStorage.getItem(SIDEBAR_RAIL_PROJECT_KEY);
		return raw && raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

/** Focus a project (`null` returns to Home) and notify every consumer. */
export function setRailProject(path: string | null): void {
	try {
		if (path) {
			localStorage.setItem(SIDEBAR_RAIL_PROJECT_KEY, path);
		} else {
			localStorage.removeItem(SIDEBAR_RAIL_PROJECT_KEY);
		}
	} catch {
		// Persistence is best-effort.
	}
	for (const cb of listeners) {
		cb();
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === SIDEBAR_RAIL_PROJECT_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** `[focusedPath, setFocusedPath]` for the rail's focused project. */
export function useRailProject(): [
	string | null,
	(path: string | null) => void,
] {
	const path = useSyncExternalStore(subscribe, readRailProject, () => null);
	const set = useCallback((next: string | null) => setRailProject(next), []);
	return [path, set];
}

/**
 * The focus the sidebar should apply: the stored project only while the rail
 * is on, so turning the rail off never leaves the sidebar silently filtered.
 */
export function useSidebarProjectFocus(): string | null {
	const [enabled] = useSidebarProjectRailPreference();
	const [path] = useRailProject();
	return enabled ? path : null;
}
