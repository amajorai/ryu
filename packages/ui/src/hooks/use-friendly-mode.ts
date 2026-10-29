// packages/ui/src/hooks/use-friendly-mode.ts
//
// THE one shared, persisted toggle for the app-wide "Friendly names" mode. On by
// default: technical vocabulary (model repo names, quant labels, retrieval
// strategies, embedding jargon) is replaced with plain language a non-developer
// can read. Turning it off shows the developer-accurate term instead.
//
// This lives in `@ryu/ui` — the leaf package `@ryu/blocks`, `@ryu/marketplace`,
// `@ryu/settings` and `apps/desktop` all already depend on — precisely so there is
// ONE module-level `listeners` Set. That is not tidiness, it is a correctness
// requirement, and the bug it fixes was live:
//
//   The desktop (`apps/desktop/src/hooks/useFriendlyMode.ts`) and the marketplace
//   (`packages/marketplace/src/catalog/use-friendly-mode.ts`) each had their own
//   copy of this store, each with its own `listeners` Set over the SAME storage
//   key. The `storage` event does not fire in the document that performed the
//   write — that is the whole point of it — so flipping the toggle in the
//   Appearance tab (a desktop-hook write) notified only the desktop's listeners.
//   A marketplace-rendered catalog section mounted in the same window kept
//   rendering the old vocabulary until it happened to remount. Cross-WINDOW sync
//   worked; same-window sync did not. Two stores over one key can only ever be
//   half-connected, so the fix is one store, not another listener.
//
// The storage key keeps its historical `ryu.catalog.*` name so every existing
// user's preference carries over even though the setting is now global rather
// than catalog-scoped. Do not "clean it up": renaming it silently resets the
// preference for everyone who ever turned it off.

import { useCallback, useSyncExternalStore } from "react";

/** Historical key — see the file header before renaming it. */
export const FRIENDLY_MODE_STORAGE_KEY = "ryu.catalog.friendly";

/** Default ON — only an explicit `"false"` in storage turns friendly names off. */
export const DEFAULT_FRIENDLY_MODE = true;

const listeners = new Set<() => void>();

/** Current preference. Safe in SSR / storage-denied contexts (returns the default). */
export function readFriendlyMode(): boolean {
	try {
		// Default ON: only an explicit "false" turns it off.
		return localStorage.getItem(FRIENDLY_MODE_STORAGE_KEY) !== "false";
	} catch {
		return DEFAULT_FRIENDLY_MODE;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	// Cross-tab/window updates (e.g. a second desktop window) stay in sync too.
	// Same-document updates come through `listeners`, because `storage` does not
	// fire in the writing document.
	const onStorage = (e: StorageEvent) => {
		if (e.key === FRIENDLY_MODE_STORAGE_KEY) {
			cb();
		}
	};
	if (globalThis.window !== undefined) {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(cb);
		if (globalThis.window !== undefined) {
			window.removeEventListener("storage", onStorage);
		}
	};
}

/**
 * Write the friendly-names preference and notify every consumer in this document.
 *
 * Exported separately from the hook because non-React callers need it too — the
 * Appearance settings registry resets it, and the plugin host pushes the new value
 * across the sandbox bridge (see `subscribeFriendlyMode`).
 */
export function setFriendlyMode(v: boolean): void {
	try {
		localStorage.setItem(FRIENDLY_MODE_STORAGE_KEY, v ? "true" : "false");
	} catch {
		// Non-fatal: persistence is best-effort.
	}
	for (const cb of listeners) {
		cb();
	}
}

/**
 * Non-React subscription to the preference: calls `cb` with the current value now
 * and again on every change (including cross-window). Returns an unsubscribe.
 *
 * This is what the plugin host bridges into sandboxed frames, which cannot read
 * the host's `localStorage` (they are null-origin) and so can only learn the
 * preference by being told.
 */
export function subscribeFriendlyMode(
	cb: (friendly: boolean) => void
): () => void {
	const emit = () => cb(readFriendlyMode());
	const dispose = subscribe(emit);
	emit();
	return dispose;
}

/**
 * `[friendly, setFriendly]`. Persisted, default `true`, shared across every
 * surface — and every window — that reads the preference.
 */
export function useFriendlyMode(): [boolean, (v: boolean) => void] {
	const friendly = useSyncExternalStore(
		subscribe,
		readFriendlyMode,
		() => DEFAULT_FRIENDLY_MODE
	);

	const setFriendly = useCallback((v: boolean) => {
		setFriendlyMode(v);
	}, []);

	return [friendly, setFriendly];
}
