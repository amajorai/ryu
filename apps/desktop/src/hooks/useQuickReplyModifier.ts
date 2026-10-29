import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";

export type QuickReplyModifier = "alt" | "ctrl" | "meta" | "none" | "shift";

export const QUICK_REPLY_MODIFIER_KEY = "ryu:quick-reply-modifier";
export const DEFAULT_QUICK_REPLY_MODIFIER: QuickReplyModifier = "alt";

export const QUICK_REPLY_MODIFIER_OPTIONS: {
	label: string;
	value: QuickReplyModifier;
}[] = [
	{ label: "Alt / Option", value: "alt" },
	{ label: "Control", value: "ctrl" },
	{ label: "Command / Meta", value: "meta" },
	{ label: "Shift", value: "shift" },
	{ label: "Off", value: "none" },
];

const VALID_MODIFIERS = new Set<QuickReplyModifier>([
	"alt",
	"ctrl",
	"meta",
	"none",
	"shift",
]);
const listeners = new Set<() => void>();
let memoryModifier: QuickReplyModifier = DEFAULT_QUICK_REPLY_MODIFIER;

function isQuickReplyModifier(
	value: string | null
): value is QuickReplyModifier {
	for (const candidate of VALID_MODIFIERS) {
		if (candidate === value) {
			return true;
		}
	}
	return false;
}

function readModifier(): QuickReplyModifier {
	try {
		const value = localStorage.getItem(QUICK_REPLY_MODIFIER_KEY);
		if (isQuickReplyModifier(value)) {
			memoryModifier = value;
			return value;
		}
		return DEFAULT_QUICK_REPLY_MODIFIER;
	} catch {
		// Headless/browser-isolated surfaces may not expose localStorage.
	}
	return memoryModifier;
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === QUICK_REPLY_MODIFIER_KEY) {
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
export function readQuickReplyModifier(): QuickReplyModifier {
	return readModifier();
}

export function setQuickReplyModifier(modifier: QuickReplyModifier): void {
	memoryModifier = modifier;
	try {
		localStorage.setItem(QUICK_REPLY_MODIFIER_KEY, modifier);
	} catch {
		// A preference that cannot be persisted still applies for this window.
	}
	for (const listener of listeners) {
		listener();
	}
}

export interface QuickReplyModifierEvent {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

/** Whether a pointer event carries the configured quick-reply modifier. */
export function quickReplyModifierMatches(
	event: QuickReplyModifierEvent,
	modifier = readModifier()
): boolean {
	switch (modifier) {
		case "alt":
			return event.altKey;
		case "ctrl":
			return event.ctrlKey;
		case "meta":
			return event.metaKey;
		case "shift":
			return event.shiftKey;
		case "none":
			return false;
	}
}

/** `[modifier, setModifier]` for Settings → Keyboard shortcuts. */
export function useQuickReplyModifier(): [
	QuickReplyModifier,
	(modifier: QuickReplyModifier) => void,
] {
	const modifier = useSyncExternalStore(
		subscribe,
		readModifier,
		() => DEFAULT_QUICK_REPLY_MODIFIER
	);
	const setModifier = useCallback(
		(next: QuickReplyModifier) => setQuickReplyModifier(next),
		[]
	);
	return [modifier, setModifier];
}

registerSetting({
	category: "shortcuts",
	id: "shortcuts.chat.quick-reply-modifier",
	label: "Quick reply click modifier",
	reset: () => setQuickReplyModifier(DEFAULT_QUICK_REPLY_MODIFIER),
});
