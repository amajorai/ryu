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
}

// Default: collapsed — only the logo circle shows, docked bottom-left. No
// long/expanded island until the user taps or a promo
// surfaces it.
let snapshot: IslandSnapshot = { state: "collapsed", hasPromo: false };
const SERVER_SNAPSHOT: IslandSnapshot = { state: "collapsed", hasPromo: false };
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
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
