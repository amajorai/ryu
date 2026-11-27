import { z } from "zod";
// apps/desktop/src/hooks/useUsageBarPrefs.ts
//
// Display preferences for subscription usage: the rings at the side of the
// window (`components/usage-rail`) and the meter on a provider row of the
// picker. These are pure UI choices, so they live in localStorage and sync
// across every mounted surface through a tiny external store. The usage data
// itself comes from Core.
//
// Two knobs:
//   - sidebar: show the usage rings in the sidebar and in the narrow rail.
//   - mode:    whether a percentage means how much is USED or how much is
//              LEFT ("remaining"). Core only reports percent-used, so
//              "remaining" is computed as 100 - used.
//
// The storage key is older than the rings. It once also held `visible` (the
// composer meter), `showBar`, `barStyle` and `showPercent`, which no surface
// reads any more. A stored value from then still loads: `sidebar` keeps what
// the user chose, so a sidebar meter that was turned off stays off. The old
// fields are written back untouched, because the key is synced between
// devices and an older app on another device still reads them.

import { useSyncExternalStore } from "react";

export type UsageBarMode = "used" | "remaining";

export interface UsageBarPrefs {
	mode: UsageBarMode;
	sidebar: boolean;
}

const storedPreferences = z.looseObject({
	mode: z.string().optional(),
	sidebar: z.boolean().nullish(),
});

const STORAGE_KEY = "ryu:usage-bar-prefs";

/** The rings show, and a percentage reads as how much is used. */
export const DEFAULT_USAGE_BAR_PREFS: UsageBarPrefs = {
	mode: "used",
	sidebar: true,
};

const listeners = new Set<() => void>();

/** The stored object with every field it holds, or nothing when unreadable. */
function readStoredRecord(): z.infer<typeof storedPreferences> {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		const parsed = stored
			? storedPreferences.safeParse(JSON.parse(stored))
			: null;
		return parsed?.success ? parsed.data : {};
	} catch {
		return {};
	}
}

function readFromStorage(): UsageBarPrefs {
	const stored = readStoredRecord();
	return {
		mode: stored.mode === "remaining" ? "remaining" : "used",
		sidebar: stored.sidebar ?? DEFAULT_USAGE_BAR_PREFS.sidebar,
	};
}

// Cache the parsed object so `useSyncExternalStore` gets a stable reference
// between renders (it only changes when we actually mutate the prefs).
let cache: UsageBarPrefs = readFromStorage();

function getSnapshot(): UsageBarPrefs {
	return cache;
}

function getServerSnapshot(): UsageBarPrefs {
	return DEFAULT_USAGE_BAR_PREFS;
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === STORAGE_KEY) {
			// A change from another window: refresh our cache, then notify.
			cache = readFromStorage();
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** Merge in a partial update, persist it, and notify every subscriber. */
export function setUsageBarPrefs(partial: Partial<UsageBarPrefs>) {
	cache = { ...cache, ...partial };
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ ...readStoredRecord(), ...cache })
		);
	} catch {
		// Best-effort persistence; in-memory state still updates.
	}
	for (const cb of listeners) {
		cb();
	}
}

/** Restore every usage display preference to its default. */
export function resetUsageBarPrefs() {
	setUsageBarPrefs(DEFAULT_USAGE_BAR_PREFS);
}

/** Subscribe to the usage display preferences. Shared across surfaces. */
export function useUsageBarPrefs(): UsageBarPrefs {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
