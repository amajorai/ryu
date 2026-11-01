"use client";

/*
 * Tiny external store for the island shape vocabulary shared by the landing
 * hero's scripted workflow loop. The state names mirror the real app's island
 * store, which likewise defaults to "collapsed" (logo-only).
 */

import { useSyncExternalStore } from "react";

export type IslandState = "collapsed" | "idle" | "suggestion" | "expanded";

export interface IslandSnapshot {
	state: IslandState;
	/**
	 * Set while a surface draws its own island (today the landing hero's
	 * scripted workflow loop is on screen).
	 */
	suppressed: boolean;
}

let snapshot: IslandSnapshot = { state: "collapsed", suppressed: false };
const SERVER_SNAPSHOT: IslandSnapshot = {
	state: "collapsed",
	suppressed: false,
};
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
