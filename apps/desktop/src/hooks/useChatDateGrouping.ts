// apps/desktop/src/hooks/useChatDateGrouping.ts
//
// One shared, persisted toggle for grouping the sidebar's loose "Chats" by date
// (Today / Yesterday / Last week / … ) the way ChatGPT does, instead of a single
// flat list. Off by default — the flat list stays the baseline. Backed by
// localStorage and broadcast through a tiny external store so the Appearance
// setting and the sidebar stay in sync the instant either flips it.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu:sidebar-group-chats-by-date";

const listeners = new Set<() => void>();

function read(): boolean {
	try {
		// Default OFF: only an explicit "true" turns date grouping on.
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	// Cross-window updates (e.g. a second desktop window) stay in sync too.
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
 * `[groupByDate, setGroupByDate]`. Persisted, default `false`, shared across
 * windows.
 */
export function useChatDateGrouping(): [boolean, (v: boolean) => void] {
	const groupByDate = useSyncExternalStore(subscribe, read, () => false);

	const setGroupByDate = useCallback((v: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
		} catch {
			// Non-fatal: persistence is best-effort.
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [groupByDate, setGroupByDate];
}
