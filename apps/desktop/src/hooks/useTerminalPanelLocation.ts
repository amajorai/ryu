import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";

export const TERMINAL_PANEL_LOCATION_KEY = "ryu:terminal-panel-location";
export const TERMINAL_PANEL_LOCATION_VALUES = ["bottom", "right"] as const;
export type TerminalPanelLocation =
	(typeof TERMINAL_PANEL_LOCATION_VALUES)[number];
export const DEFAULT_TERMINAL_PANEL_LOCATION: TerminalPanelLocation = "bottom";

const listeners = new Set<() => void>();

export function parseTerminalPanelLocation(
	value: string | null
): TerminalPanelLocation {
	return value === "right" ? "right" : DEFAULT_TERMINAL_PANEL_LOCATION;
}

function readLocation(): TerminalPanelLocation {
	try {
		return parseTerminalPanelLocation(
			localStorage.getItem(TERMINAL_PANEL_LOCATION_KEY)
		);
	} catch {
		return DEFAULT_TERMINAL_PANEL_LOCATION;
	}
}

let cachedLocation = readLocation();

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === TERMINAL_PANEL_LOCATION_KEY) {
			cachedLocation = readLocation();
			callback();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
	};
}

export function setTerminalPanelLocation(value: TerminalPanelLocation): void {
	cachedLocation = value;
	try {
		localStorage.setItem(TERMINAL_PANEL_LOCATION_KEY, value);
	} catch {
		// Persistence is best effort; the current session still uses the new value.
	}
	for (const callback of listeners) {
		callback();
	}
}

export function useTerminalPanelLocation(): [
	TerminalPanelLocation,
	(value: TerminalPanelLocation) => void,
] {
	const location = useSyncExternalStore(
		subscribe,
		() => cachedLocation,
		() => DEFAULT_TERMINAL_PANEL_LOCATION
	);
	const setLocation = useCallback(
		(next: TerminalPanelLocation) => setTerminalPanelLocation(next),
		[]
	);
	return [location, setLocation];
}

registerSetting({
	category: "general",
	id: "general.terminal.panel-location",
	label: "Default terminal location",
	reset: () => setTerminalPanelLocation(DEFAULT_TERMINAL_PANEL_LOCATION),
});
