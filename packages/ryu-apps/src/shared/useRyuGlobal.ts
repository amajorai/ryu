// React binding for the `window.ryu` globals (spec §1.3): a `useSyncExternalStore`
// hook that re-renders when the host pushes a new value for the requested key.
//
// Subscribes to the `ryu:set_globals` DOM event the bridge dispatches on every
// globals change, and reads `window.ryu[key]` for the current value. Includes the
// initial-undefined poll guard: if `window.ryu` is not installed yet at first
// render (the bridge module hasn't run, or the host has not injected props), the
// subscribe path polls until it appears and then triggers a re-render, so a widget
// mounted before the bridge never gets stuck on a stale `undefined`.

import { useSyncExternalStore } from "react";
import type { RyuWidgetGlobals } from "./window.ryu";

const RYU_SET_GLOBALS_EVENT = "ryu:set_globals";
/** How often to poll for `window.ryu` before it is installed (ms). */
const POLL_INTERVAL_MS = 16;

function subscribe(onStoreChange: () => void): () => void {
	window.addEventListener(RYU_SET_GLOBALS_EVENT, onStoreChange);

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	if (typeof window.ryu === "undefined") {
		pollTimer = setInterval(() => {
			if (typeof window.ryu !== "undefined") {
				if (pollTimer !== null) {
					clearInterval(pollTimer);
					pollTimer = null;
				}
				onStoreChange();
			}
		}, POLL_INTERVAL_MS);
	}

	return () => {
		window.removeEventListener(RYU_SET_GLOBALS_EVENT, onStoreChange);
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	};
}

/**
 * Read one `window.ryu` global reactively.
 *
 * @example
 *   const output = useRyuGlobal("toolOutput");
 *   const theme = useRyuGlobal("theme");
 */
export function useRyuGlobal<K extends keyof RyuWidgetGlobals>(
	key: K,
): RyuWidgetGlobals[K] | undefined {
	return useSyncExternalStore(
		subscribe,
		() => window.ryu?.[key],
		() => undefined,
	);
}
