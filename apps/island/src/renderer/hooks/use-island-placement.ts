// Follows the island's placement (which footprint corner/edge is pinned to its
// on-screen anchor) from the main process. See `shared/placement.ts`.
//
// The island group is aligned inside its window to that placement, so every
// morph -- split, suggestion, the tall chat panel -- grows away from the docked
// corner while the corner itself stays put, like a popover pinned to its anchor.

import { useEffect, useLayoutEffect, useState } from "react";
import type { IslandPlacement } from "../../shared/placement.ts";

/** The current island placement, kept in sync with the main process. */
export function useIslandPlacement(): IslandPlacement {
	const [placement, setPlacement] = useState<IslandPlacement>(
		() => window.island.win.initialPlacement
	);

	useEffect(() => window.island.win.onPlacement(setPlacement), []);

	// Acknowledge once the new alignment is committed to the DOM (before paint),
	// so main moves the fixed-size window in the same beat and the island never
	// shows a frame at the old alignment in the new spot.
	useLayoutEffect(() => {
		window.island.win.placementApplied(placement);
	}, [placement]);

	return placement;
}
