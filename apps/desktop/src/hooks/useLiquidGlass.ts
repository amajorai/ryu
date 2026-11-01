// Desktop-only Liquid Glass preference (Settings → Appearance → Interface).
//
// On by default. Turning it off asks the native shell to drop the macOS 26+
// NSGlassEffectView backdrop (it falls back to the existing vibrancy, so the
// independent sidebar/window transparency switches keep working) and marks the
// document root so every CSS glass material in the web layer (the glasscn
// LiquidGlass refraction, the startup chooser and launcher glass, the Ask Ryu
// surface) renders its plain translucent fallback instead.
//
// The main Ryu shell and the standalone Ryu Bot build share this code, so the
// same switch drives both.

import { useEffect } from "react";
import { SETTINGS_REMOTE_APPLIED_EVENT } from "../lib/settings-sync/local-store.ts";
import { invokeWhenReady } from "../lib/tauri-ready.ts";
import {
	setPersistedToggle,
	usePersistedToggle,
} from "./usePersistedToggle.ts";

export const LIQUID_GLASS_KEY = "ryu:liquid-glass";
export const DEFAULT_LIQUID_GLASS = true;
export const LIQUID_GLASS_ATTRIBUTE = "data-ryu-liquid-glass";
export const SET_LIQUID_GLASS_COMMAND = "set_liquid_glass";

/** The persisted choice; a missing or unreadable value means enabled. */
export function readLiquidGlassPreference(): boolean {
	try {
		const value = localStorage.getItem(LIQUID_GLASS_KEY);
		return value === null ? DEFAULT_LIQUID_GLASS : value === "true";
	} catch {
		return DEFAULT_LIQUID_GLASS;
	}
}

/** Mark the document root so CSS glass materials pick their fallback. */
export function applyLiquidGlassAttribute(
	enabled = readLiquidGlassPreference()
): void {
	if (globalThis.document === undefined) {
		return;
	}
	const root = document.documentElement;
	if (enabled) {
		root.removeAttribute(LIQUID_GLASS_ATTRIBUTE);
	} else {
		root.setAttribute(LIQUID_GLASS_ATTRIBUTE, "off");
	}
}

/**
 * Tell the native shell which window material to install. Outside Tauri (the
 * browser harness, the webapp's shimmed invoke) the call rejects and the CSS
 * attribute alone carries the preference, so the failure is ignored.
 */
export function syncNativeLiquidGlass(
	enabled = readLiquidGlassPreference()
): Promise<void> {
	if (globalThis.window === undefined) {
		return Promise.resolve();
	}
	return invokeWhenReady<void>(SET_LIQUID_GLASS_COMMAND, { enabled }).catch(
		() => undefined
	);
}

/** Apply the choice to both the document root and the native window. */
export function applyLiquidGlassPreference(
	enabled = readLiquidGlassPreference()
): void {
	applyLiquidGlassAttribute(enabled);
	void syncNativeLiquidGlass(enabled);
}

let storageListenerInstalled = false;

/** Apply the persisted choice before the first Desktop render. */
export function initLiquidGlass(): void {
	applyLiquidGlassPreference();
	if (storageListenerInstalled || globalThis.window === undefined) {
		return;
	}
	storageListenerInstalled = true;
	// Another window flipped the switch.
	window.addEventListener("storage", (event) => {
		if (event.key === LIQUID_GLASS_KEY) {
			applyLiquidGlassPreference();
		}
	});
	// Settings sync wrote a value from another device into THIS window. That
	// write bypasses the patched setter, so no `storage` event reaches us.
	window.addEventListener(SETTINGS_REMOTE_APPLIED_EVENT, (event) => {
		const detail: unknown = (event as CustomEvent<unknown>).detail;
		if (
			typeof detail === "object" &&
			detail !== null &&
			"key" in detail &&
			detail.key === LIQUID_GLASS_KEY
		) {
			applyLiquidGlassPreference();
		}
	});
}

/** Persist and immediately apply the Liquid Glass choice. */
export function setLiquidGlass(enabled: boolean): void {
	setPersistedToggle(LIQUID_GLASS_KEY, enabled);
	applyLiquidGlassPreference(enabled);
}

/** Read and observe the Liquid Glass choice. */
export function useLiquidGlass(): readonly [
	boolean,
	(enabled: boolean) => void,
] {
	const [enabled] = usePersistedToggle(LIQUID_GLASS_KEY, DEFAULT_LIQUID_GLASS);

	useEffect(() => {
		applyLiquidGlassAttribute(enabled);
	}, [enabled]);

	return [enabled, setLiquidGlass];
}
