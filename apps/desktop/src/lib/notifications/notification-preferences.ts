import { useSyncExternalStore } from "react";

/**
 * Whether this device shows OS-level notifications (desktop banners, browser
 * extension notifications, browser/mobile-web notifications). Device-local on
 * purpose: the OS or browser grant it depends on belongs to this device, so the
 * key is not part of settings sync.
 */
export const OS_NOTIFICATIONS_ENABLED_KEY = "ryu:os-notifications-enabled";

const listeners = new Set<() => void>();

interface ExtensionStorageArea {
	set: (items: Record<string, unknown>) => Promise<void> | void;
}

/**
 * The browser extension's background worker raises notifications while no Ryu
 * tab is open, and has no `localStorage`; it reads the choice from extension
 * storage instead. A no-op outside the extension.
 */
function mirrorToExtensionStorage(enabled: boolean): void {
	const chromeLike = (
		globalThis as {
			chrome?: {
				runtime?: { id?: string };
				storage?: { local?: ExtensionStorageArea };
			};
		}
	).chrome;
	const local = chromeLike?.runtime?.id ? chromeLike.storage?.local : undefined;
	if (!local) {
		return;
	}
	try {
		Promise.resolve(
			local.set({ [OS_NOTIFICATIONS_ENABLED_KEY]: enabled })
		).catch(() => undefined);
	} catch {
		// Extension storage can be unavailable while the page unloads.
	}
}

/** `true`/`false` once the user chose; `null` while they have not. */
export function readOsNotificationsChoice(): boolean | null {
	try {
		const stored = localStorage.getItem(OS_NOTIFICATIONS_ENABLED_KEY);
		if (stored === "true") {
			return true;
		}
		if (stored === "false") {
			return false;
		}
		return null;
	} catch {
		return null;
	}
}

/** Persist the user's choice and update every subscriber in this window. */
export function setOsNotificationsEnabled(enabled: boolean): void {
	try {
		localStorage.setItem(OS_NOTIFICATIONS_ENABLED_KEY, String(enabled));
	} catch {
		// Storage can be unavailable (private windows); the choice then lasts
		// for this page only through the listeners below.
	}
	mirrorToExtensionStorage(enabled);
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === OS_NOTIFICATIONS_ENABLED_KEY) {
			callback();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
	};
}

/** Read the user's choice reactively (`null` = not chosen yet). */
export function useOsNotificationsChoice(): boolean | null {
	return useSyncExternalStore(subscribe, readOsNotificationsChoice, () => null);
}
