// packages/ui/src/hooks/use-popup-overlay-blur.ts
//
// Shared persisted preference for the optional backdrop behind anchored popup
// surfaces. Desktop owns the setting and boots it before the first render; the
// UI primitives keep the actual backdrop implementation in @ryu/ui so every
// desktop popup reads the same document-level state.

import { useSyncExternalStore } from "react";
import { THEME_APPEARANCE_CHANGE_EVENT } from "../theme/prefs.ts";

export const POPUP_OVERLAY_BLUR_STORAGE_KEY = "ryu_popup_overlay_blur";
export const DEFAULT_POPUP_OVERLAY_BLUR = false;

const listeners = new Set<() => void>();

function applyPopupOverlayBlur(enabled: boolean): void {
	if (globalThis.document === undefined) {
		return;
	}

	const root = document.documentElement;
	if (enabled) {
		root.setAttribute("data-popup-overlay-blur", "on");
	} else {
		root.removeAttribute("data-popup-overlay-blur");
	}
}

export function readPopupOverlayBlur(): boolean {
	try {
		return localStorage.getItem(POPUP_OVERLAY_BLUR_STORAGE_KEY) === "true";
	} catch {
		return DEFAULT_POPUP_OVERLAY_BLUR;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	const onStorage = (event: StorageEvent) => {
		if (event.key === POPUP_OVERLAY_BLUR_STORAGE_KEY) {
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

/** Persist and apply the popup backdrop preference immediately. */
export function setPopupOverlayBlur(enabled: boolean): void {
	try {
		localStorage.setItem(POPUP_OVERLAY_BLUR_STORAGE_KEY, String(enabled));
	} catch {
		// Persistence is best-effort.
	}

	applyPopupOverlayBlur(enabled);
	for (const listener of listeners) {
		listener();
	}
	if (globalThis.window !== undefined) {
		window.dispatchEvent(new Event(THEME_APPEARANCE_CHANGE_EVENT));
	}
}

/** Apply the saved popup backdrop preference before the first desktop paint. */
export function initPopupOverlayBlur(): void {
	applyPopupOverlayBlur(readPopupOverlayBlur());
}

export function usePopupOverlayBlur(): boolean {
	return useSyncExternalStore(
		subscribe,
		readPopupOverlayBlur,
		() => DEFAULT_POPUP_OVERLAY_BLUR
	);
}
