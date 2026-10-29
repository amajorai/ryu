// Reads the island's appearance (background treatment) from the main process.
//
// Desktop Settings writes the value to Core; main answers with the Background it
// actually built the live window in. A change to the *window mode* recreates +
// reloads the window (see `main/index.ts`), so a one-shot read on mount always
// reflects the current mode — no live subscription is needed here.

import { useEffect, useState } from "react";
import {
	DEFAULT_APPEARANCE,
	type IslandBackground,
	parseAppearance,
} from "../../shared/appearance.ts";

/**
 * The live window's background: `"acrylic"` (default), `"mica"` or
 * `"translucent"`, or `null` until main has answered. Callers draw nothing while
 * it is `null`, so the first frame is never styled for the wrong window. A read
 * that fails falls back to the default rather than leaving the Island blank.
 */
export function useIslandAppearance(): IslandBackground | null {
	const [background, setBackground] = useState<IslandBackground | null>(null);

	useEffect(() => {
		let cancelled = false;
		window.island.appearance
			.get()
			.then(
				(raw) => parseAppearance(raw).background,
				() => DEFAULT_APPEARANCE.background
			)
			.then((background) => {
				if (!cancelled) {
					setBackground(background);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return background;
}
