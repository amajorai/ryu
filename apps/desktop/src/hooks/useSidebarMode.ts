import { useCallback, useSyncExternalStore } from "react";

/**
 * How the left sidebar lays out its content sections.
 *
 * - "sections": the default — every section is stacked as its own collapsible
 *   group (Agents, Workflows, Chats, …), all visible at once.
 * - "tabbed": the section labels become a row of buttons at the top; clicking a
 *   button reveals just that one section's list below, like browser tabs.
 */
export type SidebarMode = "sections" | "tabbed";

const STORAGE_KEY = "ryu:sidebar-mode";
const DEFAULT_MODE: SidebarMode = "sections";

const listeners = new Set<() => void>();

function read(): SidebarMode {
	try {
		return localStorage.getItem(STORAGE_KEY) === "tabbed"
			? "tabbed"
			: "sections";
	} catch {
		return DEFAULT_MODE;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/**
 * Read + set the sidebar layout mode. Persists to localStorage and broadcasts to
 * every mounted instance (other windows via the `storage` event, same-window
 * subscribers via the listener set), mirroring useFriendlyMode.
 */
export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
	const mode = useSyncExternalStore(subscribe, read, () => DEFAULT_MODE);

	const setMode = useCallback((next: SidebarMode) => {
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// best-effort
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [mode, setMode];
}
