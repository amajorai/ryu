import { LANGUAGE_PACK_STORAGE_KEY } from "@ryu/i18n/core";
import { useCallback, useSyncExternalStore } from "react";

export const LANGUAGE_MODE_KEY = "ryu:language-mode";
export const LANGUAGE_MODE_CHANGED_EVENT = "ryu:language-mode-changed";
export const LANGUAGE_MODE_VALUES = ["auto", "fixed"] as const;
export type LanguageMode = (typeof LANGUAGE_MODE_VALUES)[number];

export function parseLanguageMode(
	storedMode: string | null,
	storedPackId: string | null
): LanguageMode {
	if (storedMode === "fixed" || storedMode === "auto") {
		return storedMode;
	}
	return storedPackId ? "fixed" : "auto";
}

function readMode(): LanguageMode {
	try {
		const storedMode = localStorage.getItem(LANGUAGE_MODE_KEY);
		// Existing Desktop builds persisted a selected pack without a separate mode.
		// Keep that deliberate selection fixed instead of silently changing it to the
		// new auto-detect default on the first upgrade.
		return parseLanguageMode(
			storedMode,
			localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)
		);
	} catch {
		return "auto";
	}
}

const listeners = new Set<() => void>();
let cachedMode = readMode();

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === LANGUAGE_MODE_KEY) {
			cachedMode = readMode();
			callback();
		}
	};
	const onModeChanged = () => {
		cachedMode = readMode();
		callback();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(LANGUAGE_MODE_CHANGED_EVENT, onModeChanged);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(LANGUAGE_MODE_CHANGED_EVENT, onModeChanged);
	};
}

export function readLanguageMode(): LanguageMode {
	return cachedMode;
}

export function setLanguageMode(mode: LanguageMode): void {
	cachedMode = mode;
	try {
		localStorage.setItem(LANGUAGE_MODE_KEY, mode);
	} catch {
		// Persistence is best effort; the current session still uses the new mode.
	}
	window.dispatchEvent(new Event(LANGUAGE_MODE_CHANGED_EVENT));
}

export function useLanguageMode(): [
	LanguageMode,
	(mode: LanguageMode) => void,
] {
	const mode = useSyncExternalStore(
		subscribe,
		() => cachedMode,
		(): LanguageMode => "auto"
	);
	const setMode = useCallback(
		(next: LanguageMode) => setLanguageMode(next),
		[]
	);
	return [mode, setMode];
}
