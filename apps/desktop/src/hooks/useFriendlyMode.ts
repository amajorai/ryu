// apps/desktop/src/hooks/useFriendlyMode.ts
//
// One shared, persisted toggle for the app-wide "Friendly names" mode. On by
// default: model/skill names are Title-Cased and sizes/quants show
// plain-language labels instead of raw developer strings. Backed by localStorage
// and broadcast through a tiny external store so every surface that reads it
// (the Store catalog tabs, the Download Center, agent model pickers, the global
// Appearance setting, …) stays in sync the instant any of them flips it.
//
// The storage key keeps its historical `ryu.catalog.*` name so existing users'
// preference carries over even though the setting is now global.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu.catalog.friendly";

const listeners = new Set<() => void>();

function read(): boolean {
	try {
		// Default ON: only an explicit "false" turns it off.
		return localStorage.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	// Cross-tab/window updates (e.g. a second desktop window) stay in sync too.
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
 * `[friendly, setFriendly]`. Persisted, default `true`, shared across both
 * catalog tabs within (and across) windows.
 */
export function useFriendlyMode(): [boolean, (v: boolean) => void] {
	const friendly = useSyncExternalStore(subscribe, read, () => true);

	const setFriendly = useCallback((v: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
		} catch {
			// Non-fatal: persistence is best-effort.
		}
		for (const cb of listeners) {
			cb();
		}
	}, []);

	return [friendly, setFriendly];
}
