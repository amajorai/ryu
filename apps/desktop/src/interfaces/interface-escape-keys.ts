// The keys no interface can swallow. One keydown listener on `window` in the
// capture phase, added when this module first loads (before any renderer has
// mounted, so before any renderer's own capture listener): it runs ahead of
// every renderer handler, so `stopPropagation` or an isolating key handler in
// a renderer can never block it.
//
// - The Switch Interface chord (rebindable; Mod+Shift+U by default) opens
//   the switcher on screen, or the fallback dialog.
// - Holding Escape for a second while an interface (not the chat or the OS
//   desktop) is shown goes straight back to the default chat.

import { type Chord, chordMatches } from "@ryu/hotkeys/chord";
import { openInterfaceSwitcher } from "./interface-switcher.ts";

/** How long Escape must be held to leave an interface for the chat. */
export const ESCAPE_HOLD_MS = 1000;

export interface InterfaceEscapeConfig {
	/** The user's Switch Interface chord, or null when they cleared it. */
	binding: Chord | null;
	/** Whether this window may switch interfaces at all. */
	enabled: boolean;
	/** True while an interface (not the chat or OS desktop) is on screen. */
	interfaceShown: boolean;
	/** Leave for the default chat. */
	onBackToChat: () => void;
}

let config: InterfaceEscapeConfig = {
	binding: null,
	enabled: false,
	interfaceShown: false,
	onBackToChat: () => undefined,
};
let escapeTimer: number | undefined;

/** Point the always-on listener at the app's current state. */
export function configureInterfaceEscape(next: InterfaceEscapeConfig): void {
	config = next;
}

function cancelEscapeHold(): void {
	if (escapeTimer !== undefined) {
		window.clearTimeout(escapeTimer);
		escapeTimer = undefined;
	}
}

function onKeyDown(event: KeyboardEvent): void {
	if (!config.enabled) {
		return;
	}
	if (config.binding && chordMatches(config.binding, event)) {
		event.preventDefault();
		event.stopImmediatePropagation();
		openInterfaceSwitcher();
		return;
	}
	if (event.key === "Escape" && config.interfaceShown && !event.repeat) {
		cancelEscapeHold();
		escapeTimer = window.setTimeout(() => {
			escapeTimer = undefined;
			config.onBackToChat();
		}, ESCAPE_HOLD_MS);
	}
}

function onKeyUp(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		cancelEscapeHold();
	}
}

let installed = false;

/** Add the capture listeners once per window (idempotent). */
export function installInterfaceEscapeKeys(): void {
	if (installed || typeof window === "undefined") {
		return;
	}
	installed = true;
	window.addEventListener("keydown", onKeyDown, { capture: true });
	window.addEventListener("keyup", onKeyUp, { capture: true });
	window.addEventListener("blur", cancelEscapeHold);
}

installInterfaceEscapeKeys();
