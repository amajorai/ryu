import { useCallback, useSyncExternalStore } from "react";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";

/**
 * A one-shot request for a workbench tool tab: a command for a terminal to
 * run, or the paths a Changes tab should review. The nonce changes on every
 * request, so a repeated request runs again and an old one never replays on
 * remount.
 */
export interface PanelCommand {
	command?: TerminalCommandRequest;
	nonce: number;
	/** Files a Changes tab reviews (one turn's edits). */
	reviewPaths?: string[];
}

const commands = new Map<string, PanelCommand>();
const listeners = new Map<string, Set<() => void>>();

/** Queue a request for the tool tab `itemId`. */
export function queuePanelCommand(itemId: string, command: PanelCommand): void {
	commands.set(itemId, command);
	for (const listener of listeners.get(itemId) ?? []) {
		listener();
	}
}

/** The request queued for a tool tab, outside React. */
export function getPanelCommand(itemId: string): PanelCommand | undefined {
	return commands.get(itemId);
}

/** Forget a closed tab's request. */
export function clearPanelCommand(itemId: string): void {
	commands.delete(itemId);
}

/** The latest request queued for a tool tab. */
export function usePanelCommand(itemId: string): PanelCommand | undefined {
	const subscribe = useCallback(
		(listener: () => void) => {
			let set = listeners.get(itemId);
			if (!set) {
				set = new Set();
				listeners.set(itemId, set);
			}
			set.add(listener);
			return () => {
				set?.delete(listener);
				if (set?.size === 0) {
					listeners.delete(itemId);
				}
			};
		},
		[itemId]
	);
	const read = useCallback(() => commands.get(itemId), [itemId]);
	return useSyncExternalStore(subscribe, read);
}
