import { useEffect } from "react";
import { type IslandState, useIslandState } from "../store/island-state.ts";

/** Maps the number keys 0-4 to island states for manual verification. */
const KEY_TO_STATE: Record<string, IslandState> = {
	"0": "collapsed",
	"1": "idle",
	"2": "context",
	"3": "suggestion",
	"4": "expanded",
};

/**
 * Dev-only keyboard switcher: press 0-4 to jump to a state, or Tab/Space to
 * cycle through `ISLAND_STATE_ORDER`. Lets a human eyeball every morph without
 * any real data wiring (which arrives in later units).
 */
export function useDevStateSwitcher(): void {
	const setState = useIslandState((store) => store.setState);
	const cycle = useIslandState((store) => store.cycle);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const target = KEY_TO_STATE[event.key];
			if (target) {
				event.preventDefault();
				setState(target);
				return;
			}
			if (event.key === "Tab" || event.key === " ") {
				event.preventDefault();
				cycle();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [setState, cycle]);
}
