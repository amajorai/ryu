// The OS-level "reduce motion" accessibility preference, as a reactive hook.
//
// One definition on purpose: this used to be inlined in
// ChatDisplayPrefsProvider, and a second copy elsewhere is how the chat and the
// chrome end up disagreeing about whether motion is allowed.

import { useSyncExternalStore } from "react";

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
	if (globalThis.window === undefined || !window.matchMedia) {
		return () => {
			// nothing to unsubscribe from
		};
	}
	const mql = window.matchMedia(REDUCE_MOTION_QUERY);
	mql.addEventListener("change", cb);
	return () => mql.removeEventListener("change", cb);
}

function read(): boolean {
	if (globalThis.window === undefined || !window.matchMedia) {
		return false;
	}
	return window.matchMedia(REDUCE_MOTION_QUERY).matches;
}

/** OS-level "reduce motion" accessibility preference, reactive to changes. */
export function usePrefersReducedMotion(): boolean {
	return useSyncExternalStore(subscribe, read, () => false);
}
