// Desktop-only window surface preferences.
//
// Tauri creates the shell as a transparent window. These preferences decide
// which of the React surfaces let that native backdrop show through. Keeping
// the booleans separate is intentional: a translucent sidebar can sit over an
// opaque page, and a translucent page can keep an opaque sidebar.

import { useEffect } from "react";
import { useAppSurface } from "../contexts/app-surface-context.tsx";
import {
	setPersistedToggle,
	usePersistedToggle,
} from "./usePersistedToggle.ts";

export const SIDEBAR_TRANSPARENCY_KEY = "ryu:sidebar-transparency";
export const WINDOW_TRANSPARENCY_KEY = "ryu:window-transparency";

export const DEFAULT_SIDEBAR_TRANSPARENCY = false;
export const DEFAULT_WINDOW_TRANSPARENCY = false;

const SIDEBAR_TRANSPARENCY_ATTRIBUTE = "data-ryu-sidebar-transparency";
const WINDOW_TRANSPARENCY_ATTRIBUTE = "data-ryu-window-transparency";

function readPreference(key: string, defaultValue: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		return value === null ? defaultValue : value === "true";
	} catch {
		return defaultValue;
	}
}

function setBooleanAttribute(
	root: HTMLElement,
	attribute: string,
	enabled: boolean
): void {
	if (enabled) {
		root.setAttribute(attribute, "true");
	} else {
		root.removeAttribute(attribute);
	}
}

/** Apply both independent surface choices to the document root. */
export function applyWindowTransparencyPreferences(
	sidebarTransparent = readPreference(
		SIDEBAR_TRANSPARENCY_KEY,
		DEFAULT_SIDEBAR_TRANSPARENCY
	),
	windowTransparent = readPreference(
		WINDOW_TRANSPARENCY_KEY,
		DEFAULT_WINDOW_TRANSPARENCY
	)
): void {
	if (globalThis.document === undefined) {
		return;
	}

	const root = document.documentElement;
	setBooleanAttribute(root, SIDEBAR_TRANSPARENCY_ATTRIBUTE, sidebarTransparent);
	setBooleanAttribute(root, WINDOW_TRANSPARENCY_ATTRIBUTE, windowTransparent);
}

/** Apply persisted choices before the first Desktop render. */
export function initWindowTransparency(): void {
	applyWindowTransparencyPreferences();
}

/** Persist and immediately apply the sidebar-only choice. */
export function setSidebarTransparency(enabled: boolean): void {
	setPersistedToggle(SIDEBAR_TRANSPARENCY_KEY, enabled);
	applyWindowTransparencyPreferences();
}

/** Persist and immediately apply the whole-window choice. */
export function setWindowTransparency(enabled: boolean): void {
	setPersistedToggle(WINDOW_TRANSPARENCY_KEY, enabled);
	applyWindowTransparencyPreferences();
}

/** Read and observe the sidebar transparency choice. */
export function useSidebarTransparency(): readonly [
	boolean,
	(enabled: boolean) => void,
] {
	const { isDesktop } = useAppSurface();
	const [enabled] = usePersistedToggle(
		SIDEBAR_TRANSPARENCY_KEY,
		DEFAULT_SIDEBAR_TRANSPARENCY
	);

	useEffect(() => {
		if (isDesktop) {
			applyWindowTransparencyPreferences();
		}
	}, [enabled, isDesktop]);

	return [enabled, setSidebarTransparency];
}

/** Read and observe the whole-window transparency choice. */
export function useWindowTransparency(): readonly [
	boolean,
	(enabled: boolean) => void,
] {
	const { isDesktop } = useAppSurface();
	const [enabled] = usePersistedToggle(
		WINDOW_TRANSPARENCY_KEY,
		DEFAULT_WINDOW_TRANSPARENCY
	);

	useEffect(() => {
		if (isDesktop) {
			applyWindowTransparencyPreferences();
		}
	}, [enabled, isDesktop]);

	return [enabled, setWindowTransparency];
}
