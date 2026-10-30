import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

// Mod+Shift+K opens the Board's command menu when focus is on the board
// (or nowhere yet, right after switching here). Mod+K is the desktop's
// command palette and the board leaves it alone, so that palette works here
// too. The open conversation and anything layered over the board keep the
// chord to themselves, and a chord something else already handled (its
// default prevented) is left alone.
export function useBoardCommandsChord(
	rootRef: RefObject<HTMLDivElement | null>,
	setPaletteOpen: Dispatch<SetStateAction<boolean>>
) {
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			const root = rootRef.current;
			const target = event.target;
			if (
				!(root && (event.metaKey || event.ctrlKey) && event.shiftKey) ||
				event.altKey ||
				event.defaultPrevented ||
				event.key.toLowerCase() !== "k"
			) {
				return;
			}
			const onBoard =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && root.contains(target));
			const inThread =
				target instanceof Element &&
				target.closest("[data-testid='board-thread-panel']") !== null;
			if (!onBoard || inThread) {
				return;
			}
			event.preventDefault();
			setPaletteOpen((open) => !open);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [rootRef, setPaletteOpen]);
}
