import type { ComposerSendShortcut } from "@ryu/blocks/desktop/agent-elements/composer-send-shortcut.ts";
import { useCallback, useSyncExternalStore } from "react";
import { registerSetting } from "@/src/lib/settings-registry.ts";

export type { ComposerSendShortcut } from "@ryu/blocks/desktop/agent-elements/composer-send-shortcut.ts";

export const COMPOSER_SEND_SHORTCUT_KEY = "ryu:composer-send-shortcut";

export const DEFAULT_COMPOSER_SEND_SHORTCUT: ComposerSendShortcut = "enter";

export const COMPOSER_SEND_SHORTCUT_OPTIONS: {
	label: string;
	value: ComposerSendShortcut;
}[] = [
	{ value: "enter", label: "Enter" },
	{ value: "shift-enter", label: "Shift + Enter" },
	{ value: "command-enter", label: "Command/Ctrl + Enter" },
];

const VALID_COMPOSER_SEND_SHORTCUTS = new Set<ComposerSendShortcut>([
	"enter",
	"shift-enter",
	"command-enter",
]);

const listeners = new Set<() => void>();

function isComposerSendShortcut(
	value: string | null
): value is ComposerSendShortcut {
	for (const candidate of VALID_COMPOSER_SEND_SHORTCUTS) {
		if (candidate === value) {
			return true;
		}
	}
	return false;
}

function readMode(): ComposerSendShortcut {
	try {
		const value = localStorage.getItem(COMPOSER_SEND_SHORTCUT_KEY);
		return isComposerSendShortcut(value)
			? value
			: DEFAULT_COMPOSER_SEND_SHORTCUT;
	} catch {
		return DEFAULT_COMPOSER_SEND_SHORTCUT;
	}
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === COMPOSER_SEND_SHORTCUT_KEY) {
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

export function subscribeComposerSendShortcut(
	callback: () => void
): () => void {
	return subscribe(callback);
}

/** Read the setting synchronously for non-React send/notification paths. */
export function readComposerSendShortcut(): ComposerSendShortcut {
	return readMode();
}

export function setComposerSendShortcut(mode: ComposerSendShortcut): void {
	try {
		localStorage.setItem(COMPOSER_SEND_SHORTCUT_KEY, mode);
	} catch {
		// A preference that cannot be persisted still applies for this window.
	}
	for (const listener of listeners) {
		listener();
	}
}

/** `[mode, setMode]` for the General → Chats preference. */
export function useComposerSendShortcut(): [
	ComposerSendShortcut,
	(mode: ComposerSendShortcut) => void,
] {
	const mode = useSyncExternalStore(
		subscribe,
		readMode,
		() => DEFAULT_COMPOSER_SEND_SHORTCUT
	);
	const setMode = useCallback(
		(next: ComposerSendShortcut) => setComposerSendShortcut(next),
		[]
	);
	return [mode, setMode];
}

registerSetting({
	category: "general",
	id: "general.chats.send-shortcut",
	label: "Send shortcut",
	reset: () => setComposerSendShortcut(DEFAULT_COMPOSER_SEND_SHORTCUT),
});
