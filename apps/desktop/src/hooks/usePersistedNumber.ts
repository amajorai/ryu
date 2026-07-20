// apps/desktop/src/hooks/usePersistedNumber.ts
//
// A localStorage-backed numeric setting shared across components via an external
// store, so every consumer of the same key stays in sync the instant any of
// them changes it (within and across windows). The numeric sibling of
// usePersistedToggle — used for things like the "unload inactive tabs after X
// minutes" preference.

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function read(key: string, defaultValue: number): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) {
			return defaultValue;
		}
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : defaultValue;
	} catch {
		return defaultValue;
	}
}

/** Synchronous read of a persisted number, usable outside React (e.g. timers). */
export function readPersistedNumber(key: string, defaultValue: number): number {
	return read(key, defaultValue);
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

/** `[value, setValue]` for a persisted number, synced across all consumers. */
export function usePersistedNumber(
	key: string,
	defaultValue: number
): [number, (v: number) => void] {
	const value = useSyncExternalStore(
		useCallback((cb: () => void) => subscribe(key, cb), [key]),
		useCallback(() => read(key, defaultValue), [key, defaultValue]),
		() => defaultValue
	);

	const setValue = useCallback(
		(v: number) => {
			try {
				localStorage.setItem(key, String(v));
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
