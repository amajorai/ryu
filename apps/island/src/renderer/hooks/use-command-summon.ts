import { useEffect, useRef } from "react";
import { useIslandState } from "../store/island-state.ts";
import { useIslandAppearance } from "./use-island-appearance.ts";

/**
 * Wires the merged command bar's summon lifecycle:
 *
 * 1. The global hotkey (main → `command:open`) opens the command palette surface.
 * 2. Window blur (main → `command:blur`) dismisses the command surface back to the
 *    resting pill — but only when it is the command surface that is showing, so a
 *    normal expanded panel and the suggestion/recording states are untouched. The
 *    island always persists (it collapses to `idle`, it never hides).
 * 3. Mouse-capture is forced on while expanded so a hotkey-summoned palette is
 *    typeable with the pointer nowhere near the (transparent) window, and restored
 *    to the resting mode on collapse: a translucent window returns to click-through
 *    (pointerenter re-captures), a material window stays interactive.
 */
export function useCommandSummon(): void {
	const openCommand = useIslandState((store) => store.openCommand);
	const state = useIslandState((store) => store.state);
	const background = useIslandAppearance();
	const material = background === "acrylic" || background === "mica";
	const prevExpanded = useRef(false);

	useEffect(() => {
		const offOpen = window.island.command.onOpen(() => openCommand());
		const offBlur = window.island.command.onBlur(() => {
			// Read the latest state imperatively to avoid a stale closure.
			const store = useIslandState.getState();
			if (store.state === "expanded" && store.expandedView === "command") {
				store.setState("idle");
			}
		});
		return () => {
			offOpen();
			offBlur();
		};
	}, [openCommand]);

	useEffect(() => {
		const expanded = state === "expanded";
		if (expanded && !prevExpanded.current) {
			window.island.win.setMouseCapture(true);
		} else if (!expanded && prevExpanded.current) {
			window.island.win.setMouseCapture(material);
		}
		prevExpanded.current = expanded;
	}, [state, material]);
}
