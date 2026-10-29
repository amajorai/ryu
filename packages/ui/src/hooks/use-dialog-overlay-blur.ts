// packages/ui/src/hooks/use-dialog-overlay-blur.ts
//
// THE one shared, persisted "Blur dialog backgrounds" toggle. OFF by default:
// dialogs, alert dialogs, sheets and drawers get a flat transparent look with no
// backdrop and no panel shadow. On — reachable only from the desktop Appearance
// settings — dims (30% black) and blurs (8px) the app behind them, and the
// panels themselves are translucent (`bg-popover/90 backdrop-blur-xl`) so that
// shows through.
//
// `apps/web` exposes no toggle and deliberately never bootstraps this store
// (see apps/web/src/components/providers.tsx), so the CSS base state below —
// which IS blurred — is what the web renders. This module's default therefore
// only ever decides what the desktop does.
//
// This lives in `@ryu/ui` — the leaf package `apps/web`, `apps/desktop`, and the
// other surfaces all import — so there is exactly ONE module-level `listeners`
// Set, exactly like `use-friendly-mode.ts`. Two stores over one storage key can
// only ever be half-connected (the `storage` event never fires in the document
// that performed the write), so a per-surface copy would leave the web toggle
// and a desktop window rendering stale until the other happened to remount.
//
// The storage key keeps its historical `ryu_dialog_overlay_blur` name so every
// desktop user's existing preference carries over. Do not rename it.
//
// The CSS side is `--ryu-dialog-overlay-background` / `--ryu-dialog-overlay-blur`
// in `styles/globals.css` (.ryu-dialog-overlay), plus the
// `html[data-dialog-overlay-blur="off"]` rules that hide the backdrop and strip
// panel shadows when the toggle is off. The CSS keeps blurred as its BASE state
// even though the desktop default is now off, because that is what `apps/web`
// paints with no JS at all. The desktop reaches its own default by stamping the
// attribute at boot — `initDialogOverlayBlur()` runs in `main.tsx` module scope,
// before `createRoot(...).render(...)`, so the off state is on <html> before the
// first paint rather than one effect later.

import { useSyncExternalStore } from "react";
import { THEME_APPEARANCE_CHANGE_EVENT } from "../theme/prefs.ts";

/** Historical key — see the file header before renaming it. */
export const DIALOG_OVERLAY_BLUR_STORAGE_KEY = "ryu_dialog_overlay_blur";

/** Default OFF — only an explicit `"true"` in storage enables the overlay. */
export const DEFAULT_DIALOG_OVERLAY_BLUR = false;

const ENABLED_BACKGROUND = "rgb(0 0 0 / 30%)";
const DISABLED_BACKGROUND = "rgb(0 0 0 / 0)";
const ENABLED_BLUR = "8px";
const DISABLED_BLUR = "0px";

const listeners = new Set<() => void>();

function applyOverlayVars(enabled: boolean): void {
	if (globalThis.document === undefined) {
		return;
	}
	const root = document.documentElement;
	root.style.setProperty(
		"--ryu-dialog-overlay-background",
		enabled ? ENABLED_BACKGROUND : DISABLED_BACKGROUND
	);
	root.style.setProperty(
		"--ryu-dialog-overlay-blur",
		enabled ? ENABLED_BLUR : DISABLED_BLUR
	);
	// Opt-out attribute: present only to turn the overlay OFF. See the header.
	if (enabled) {
		root.removeAttribute("data-dialog-overlay-blur");
	} else {
		root.setAttribute("data-dialog-overlay-blur", "off");
	}
}

/** Current preference. Safe in SSR / storage-denied contexts (returns the default). */
export function readDialogOverlayBlur(): boolean {
	try {
		// An absent key means "never chosen" and resolves to the OFF default.
		// Users who explicitly turned the overlay on stored `"true"` and keep it.
		return localStorage.getItem(DIALOG_OVERLAY_BLUR_STORAGE_KEY) === "true";
	} catch {
		return DEFAULT_DIALOG_OVERLAY_BLUR;
	}
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	// Cross-tab/window updates (e.g. a second desktop window) stay in sync too.
	// Same-document updates come through `listeners`, because `storage` does not
	// fire in the writing document.
	const onStorage = (e: StorageEvent) => {
		if (e.key === DIALOG_OVERLAY_BLUR_STORAGE_KEY) {
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
 * Write the overlay-blur preference and apply it to the document immediately.
 *
 * Exported separately from the hook because non-React callers need it too — the
 * desktop Appearance settings registry resets it, and app boot applies the
 * saved value via `initDialogOverlayBlur`.
 */
export function setDialogOverlayBlur(enabled: boolean): void {
	try {
		localStorage.setItem(DIALOG_OVERLAY_BLUR_STORAGE_KEY, String(enabled));
	} catch {
		// Non-fatal: persistence is best-effort.
	}
	applyOverlayVars(enabled);
	for (const cb of listeners) {
		cb();
	}
	if (globalThis.window !== undefined) {
		window.dispatchEvent(new Event(THEME_APPEARANCE_CHANGE_EVENT));
	}
}

/**
 * Apply the saved preference to the document. Call once at app boot, as early as
 * possible — the desktop calls it in `main.tsx` module scope — so both the OFF
 * default and a returning user's ON choice are on <html> before the first paint.
 */
export function initDialogOverlayBlur(): void {
	applyOverlayVars(readDialogOverlayBlur());
}

/** Current preference as a reactive value for rendering a toggle. */
export function useDialogOverlayBlur(): boolean {
	return useSyncExternalStore(
		subscribe,
		readDialogOverlayBlur,
		() => DEFAULT_DIALOG_OVERLAY_BLUR
	);
}
