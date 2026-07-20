// apps/desktop/src/hooks/useUsageBarPrefs.ts
//
// Display preferences for the composer's subscription usage meters (the little
// "agent usage left" bars beside the input, à la Codex). These are pure UI
// choices — how the meter looks, not what the numbers are — so they live in
// localStorage and sync across every mounted surface (the composer + the
// Appearance settings tab) through a tiny external store. The underlying usage
// data still comes from Core via `useAgentUsage`.
//
// Six knobs:
//   - visible:     show the usage meter in the composer, or hide it entirely.
//   - sidebar:     also show the meters next to each agent's name in the app
//                  sidebar (independent of `visible`; only supported agents like
//                  Claude Code / Codex ever render one — the rest stay clean).
//   - showBar:     show the progress indicator (turn off for a text-only meter).
//   - barStyle:    render the progress indicator as a linear "bar" or a compact
//                  circular "ring". Only matters when `showBar` is on.
//   - showPercent: show the numeric percentage inline next to the label.
//   - mode:        whether the percentage means how much is USED or how much is
//                  LEFT ("remaining"). Core only reports percent-used, so
//                  "remaining" is computed as 100 - used.

import { useSyncExternalStore } from "react";

export type UsageBarMode = "used" | "remaining";
export type UsageBarStyle = "bar" | "ring";

export interface UsageBarPrefs {
	barStyle: UsageBarStyle;
	mode: UsageBarMode;
	showBar: boolean;
	showPercent: boolean;
	sidebar: boolean;
	visible: boolean;
}

const STORAGE_KEY = "ryu:usage-bar-prefs";

/** Sensible defaults: the meter shows a bar of percent-used, no inline number,
 *  and — on by default — repeats beside each supported agent in the sidebar. */
export const DEFAULT_USAGE_BAR_PREFS: UsageBarPrefs = {
	visible: true,
	showBar: true,
	barStyle: "ring",
	showPercent: false,
	mode: "used",
	sidebar: true,
};

const listeners = new Set<() => void>();

function readFromStorage(): UsageBarPrefs {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) {
			return DEFAULT_USAGE_BAR_PREFS;
		}
		const parsed = JSON.parse(stored) as Partial<UsageBarPrefs>;
		return {
			visible: parsed.visible ?? DEFAULT_USAGE_BAR_PREFS.visible,
			showBar: parsed.showBar ?? DEFAULT_USAGE_BAR_PREFS.showBar,
			barStyle: parsed.barStyle === "ring" ? "ring" : "bar",
			showPercent: parsed.showPercent ?? DEFAULT_USAGE_BAR_PREFS.showPercent,
			mode: parsed.mode === "remaining" ? "remaining" : "used",
			sidebar: parsed.sidebar ?? DEFAULT_USAGE_BAR_PREFS.sidebar,
		};
	} catch {
		return DEFAULT_USAGE_BAR_PREFS;
	}
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
		localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
	} catch {
		// Best-effort persistence; in-memory state still updates.
	}
	for (const cb of listeners) {
		cb();
	}
}

/** Restore every usage-meter display preference to its default. */
export function resetUsageBarPrefs() {
	setUsageBarPrefs(DEFAULT_USAGE_BAR_PREFS);
}

/** Subscribe to the usage-meter display preferences. Shared across surfaces. */
export function useUsageBarPrefs(): UsageBarPrefs {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
