import type { ReactNode } from "react";
import type { IslandState } from "../store/island-state.ts";

/**
 * Content holder for the detail island. On the pill surfaces it is the *measured*
 * node: an auto-height wrapper whose natural height drives the shape's height (see
 * `useContentHeight` — measuring anything the island itself sizes would feed the
 * animated height straight back in). The expanded panel sizes itself from the
 * composer, so it renders its children bare and is never observed.
 */
export function PillBody({
	children,
	isExpanded,
	measureRef,
	state,
}: {
	children: ReactNode;
	isExpanded: boolean;
	measureRef: (node: HTMLElement | null) => void;
	state: IslandState;
}) {
	if (isExpanded) {
		return children;
	}
	// The suggestion chip lays itself out full-width; the text/recording pills are
	// centered in the shape, so the wrapper has to re-center them.
	const layout =
		state === "suggestion" ? "w-full" : "flex w-full justify-center";
	return (
		<div className={layout} ref={measureRef}>
			{children}
		</div>
	);
}
