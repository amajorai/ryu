import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";
import {
	QUICK_REPLY_MODIFIER_OPTIONS,
	type QuickReplyModifier,
	type QuickReplyModifierEvent,
	quickReplyModifierMatches,
} from "./useQuickReplyModifier.ts";

export type QuickPreviewModifier = QuickReplyModifier;

export const QUICK_PREVIEW_MODIFIER_KEY = "ryu:quick-preview-modifier";
export const DEFAULT_QUICK_PREVIEW_MODIFIER: QuickPreviewModifier = "shift";

export const QUICK_PREVIEW_MODIFIER_OPTIONS = QUICK_REPLY_MODIFIER_OPTIONS;

const listeners = new Set<() => void>();
let memoryModifier: QuickPreviewModifier = DEFAULT_QUICK_PREVIEW_MODIFIER;

function readModifier(): QuickPreviewModifier {
	try {
		const value = localStorage.getItem(QUICK_PREVIEW_MODIFIER_KEY);
		const option = QUICK_PREVIEW_MODIFIER_OPTIONS.find(
			(candidate) => candidate.value === value
		);
		if (option) {
			memoryModifier = option.value;
			return memoryModifier;
		}
		return DEFAULT_QUICK_PREVIEW_MODIFIER;
	} catch {
		// Headless/browser-isolated surfaces may not expose localStorage.
	}
	return memoryModifier;
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === QUICK_PREVIEW_MODIFIER_KEY) {
			callback();
		}
	};
	if (globalThis.window !== undefined) {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(callback);
		if (globalThis.window !== undefined) {
			window.removeEventListener("storage", onStorage);
		}
	};
}

/** Read the modifier synchronously for pointer handlers outside React. */
export function readQuickPreviewModifier(): QuickPreviewModifier {
	return readModifier();
}

export function setQuickPreviewModifier(modifier: QuickPreviewModifier): void {
	memoryModifier = modifier;
	try {
		localStorage.setItem(QUICK_PREVIEW_MODIFIER_KEY, modifier);
	} catch {
		// A preference that cannot be persisted still applies for this window.
	}
	for (const listener of listeners) {
		listener();
	}
}

/** Whether a pointer event carries the configured quick-preview modifier. */
export function quickPreviewModifierMatches(
	event: QuickReplyModifierEvent,
	modifier = readModifier()
): boolean {
	return quickReplyModifierMatches(event, modifier);
}

/** `[modifier, setModifier]` for Settings → Keyboard shortcuts. */
export function useQuickPreviewModifier(): [
	QuickPreviewModifier,
	(modifier: QuickPreviewModifier) => void,
] {
	const modifier = useSyncExternalStore(
		subscribe,
		readModifier,
		() => DEFAULT_QUICK_PREVIEW_MODIFIER
	);

	const setModifier = useCallback(
		(next: QuickPreviewModifier) => setQuickPreviewModifier(next),
		[]
	);
	return [modifier, setModifier];
}

registerSetting({
	category: "shortcuts",
	id: "shortcuts.chat.quick-preview-modifier",
	label: "Quick preview click modifier",
	reset: () => setQuickPreviewModifier(DEFAULT_QUICK_PREVIEW_MODIFIER),
});
