import {
	isNativeFunction,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useState } from "react";

/** Device-local pins for the shared composer "+" directory. */
export const COMPOSER_PINS_STORAGE_KEY = "ryu:composer-pins";

const COMPOSER_PINS_EVENT = "ryu:composer-pins-change";

function readComposerPins(): string[] {
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return [];
		}
		const raw = storage.getItem(COMPOSER_PINS_STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) {
			return [];
		}
		return [
			...new Set(
				parsed.filter((value): value is string => isNativeText(value))
			),
		];
	} catch {
		return [];
	}
}

function writeComposerPins(pinnedIds: readonly string[]): void {
	try {
		const storage = globalThis.localStorage;
		storage?.setItem(COMPOSER_PINS_STORAGE_KEY, JSON.stringify(pinnedIds));
	} catch {
		// A storage failure should make pins session-local, not break the composer.
	}
}

function notifyComposerPinsChanged(): void {
	if (isNativeFunction(globalThis.dispatchEvent)) {
		globalThis.dispatchEvent(new Event(COMPOSER_PINS_EVENT));
	}
}

/** Read the current pin order. Missing or malformed storage means no pins. */
export function getComposerPins(): string[] {
	return readComposerPins();
}

/** Toggle one composer item and return the resulting pin order. */
export function toggleComposerPin(id: string): string[] {
	const current = readComposerPins();
	const next = current.includes(id)
		? current.filter((candidate) => candidate !== id)
		: [...current, id];
	writeComposerPins(next);
	notifyComposerPinsChanged();
	return next;
}

/**
 * Shared hook for every composer surface. The custom event keeps multiple
 * composers in the same desktop window in sync; the native storage event covers
 * another window or web tab.
 */
export function useComposerPins() {
	const [pinnedIds, setPinnedIds] = useState(getComposerPins);

	useEffect(() => {
		const refresh = () => setPinnedIds(getComposerPins());
		window.addEventListener("storage", refresh);
		window.addEventListener(COMPOSER_PINS_EVENT, refresh);
		return () => {
			window.removeEventListener("storage", refresh);
			window.removeEventListener(COMPOSER_PINS_EVENT, refresh);
		};
	}, []);

	const togglePin = useCallback((id: string) => {
		setPinnedIds(toggleComposerPin(id));
	}, []);

	return { pinnedIds, togglePin };
}
