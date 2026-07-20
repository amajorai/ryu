// packages/marketplace/src/catalog/use-friendly-mode.ts
//
// One shared, persisted toggle for the app-wide "Friendly names" mode, moved into
// the shared catalog package so the Skills (and, later, Models) section reads it
// the same way on every surface. On by default: names are Title-Cased and
// sizes/quants show plain-language labels. Backed by localStorage and broadcast
// through a tiny external store so every surface reading it stays in sync the
// instant any of them flips it.
//
// The storage key keeps its historical `ryu.catalog.*` name so it shares the exact
// same preference the desktop `useFriendlyMode` hook reads/writes — the two are
// interchangeable and never diverge for a given user.

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
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			cb();
		}
	};
	if (typeof window !== "undefined") {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(cb);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onStorage);
		}
	};
}

/**
 * `[friendly, setFriendly]`. Persisted, default `true`, shared across every
 * surface (and window) that reads the `ryu.catalog.friendly` key.
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
