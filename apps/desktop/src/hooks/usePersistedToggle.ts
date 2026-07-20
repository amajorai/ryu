// apps/desktop/src/hooks/usePersistedToggle.ts
//
// A small, localStorage-backed boolean toggle shared across components via an
// external store, so every consumer of the same key stays in sync the instant
// any of them flips it (within and across windows). Generalizes the catalog's
// "Friendly names" / "Show tags" switches.

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function read(key: string, defaultValue: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) {
			return defaultValue;
		}
		return raw === "true";
	} catch {
		return defaultValue;
	}
}

function subscribe(key: string, cb: () => void): () => void {
	let set = listeners.get(key);
	if (!set) {
		set = new Set();
		listeners.set(key, set);
	}
	set.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === key) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		set?.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** `[value, setValue]` for a persisted boolean, synced across all consumers. */
export function usePersistedToggle(
	key: string,
	defaultValue: boolean
): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		useCallback((cb: () => void) => subscribe(key, cb), [key]),
		useCallback(() => read(key, defaultValue), [key, defaultValue]),
		() => defaultValue
	);

	const setValue = useCallback(
		(v: boolean) => {
			try {
				localStorage.setItem(key, v ? "true" : "false");
			} catch {
				// Persistence is best-effort.
			}
			for (const cb of listeners.get(key) ?? []) {
				cb();
			}
		},
		[key]
	);

	return [value, setValue];
}
