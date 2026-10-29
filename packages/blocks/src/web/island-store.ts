"use client";

/*
 * Tiny external store shared by the persistent GlobalIsland (mounted in the web
 * root layout, visible on every page) and the home page's AppShowcase state
 * switcher. The island lives at the layout level so it survives route changes;
 * the switcher on the landing page drives that same instance through this store
 * instead of owning its own React state. Mirrors the real app's island-state
 * store, which likewise defaults to "collapsed" (logo-only).
 */

import { useSyncExternalStore } from "react";

export type IslandState =
	| "collapsed"
	| "idle"
	| "suggestion"
	| "expanded"
	| "promo";

export interface IslandSnapshot {
	hasPromo: boolean;
	state: IslandState;
	/**
	 * Hide the persistent island entirely. Set by surfaces that draw their OWN
	 * island — today the landing hero's scripted workflow loop — so the page never
	 * shows two Ryu islands at once (the same reason `/pitch` drops it wholesale).
	 */
	suppressed: boolean;
}

// Default: collapsed — only the logo circle shows, docked bottom-left. No
// long/expanded island until the user taps or a promo
// surfaces it.
let snapshot: IslandSnapshot = {
	state: "collapsed",
	hasPromo: false,
	suppressed: false,
};
const SERVER_SNAPSHOT: IslandSnapshot = {
	state: "collapsed",
	hasPromo: false,
	suppressed: false,
};
const PROMO_DISMISSED_STORAGE_KEY = "ryu:launch-promo-dismissed";
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** Read the browser-local opt-out without making the store depend on SSR globals. */
export function hasIslandPromoBeenDismissed(): boolean {
	if (globalThis.window === undefined) {
		return false;
	}
	try {
		return window.localStorage.getItem(PROMO_DISMISSED_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

/** Permanently hide this browser's surprise promo and close any active panel. */
export function dismissIslandPromo(): void {
	if (globalThis.window !== undefined) {
		try {
			window.localStorage.setItem(PROMO_DISMISSED_STORAGE_KEY, "1");
		} catch {
			// Storage can be unavailable in private or restricted browser contexts.
		}
	}

	const changed = snapshot.state !== "collapsed" || snapshot.hasPromo;
	snapshot = { ...snapshot, hasPromo: false, state: "collapsed" };
	if (changed) {
		emit();
	}
}

export function setIslandState(state: IslandState): void {
	if (snapshot.state === state) {
		return;
	}
	snapshot = { ...snapshot, state };
	emit();
}

export function setIslandHasPromo(hasPromo: boolean): void {
	if (snapshot.hasPromo === hasPromo) {
		return;
	}
	snapshot = { ...snapshot, hasPromo };
	emit();
}

export function setIslandSuppressed(suppressed: boolean): void {
	if (snapshot.suppressed === suppressed) {
		return;
	}
	snapshot = { ...snapshot, suppressed };
	emit();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): IslandSnapshot {
	return snapshot;
}

function getServerSnapshot(): IslandSnapshot {
	return SERVER_SNAPSHOT;
}

export function useIslandStore(): IslandSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
