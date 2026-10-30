// apps/desktop/src/components/chat/launchpad-preference.ts
//
// Whether the empty chat start page shows the app launchpad row under the
// composer. Off by default (D5): the start page is a greeting and a composer.
// The composer's "+" menu carries the "Apps on start page" toggle, and the
// choice is remembered per device.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ryu:chat-launchpad";
const listeners = new Set<() => void>();

function read(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY) {
			listener();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

/** Show or hide the launchpad row on the start page. */
export function setChatLaunchpadEnabled(enabled: boolean): void {
	try {
		if (enabled) {
			localStorage.setItem(STORAGE_KEY, "on");
		} else {
			localStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// Storage can be unavailable (private mode); the toggle still applies
		// for this session through the listeners below.
	}
	for (const listener of listeners) {
		listener();
	}
}

/** Whether the start page shows the launchpad row. Defaults to off. */
export function useChatLaunchpadEnabled(): boolean {
	return useSyncExternalStore(subscribe, read, () => false);
}
