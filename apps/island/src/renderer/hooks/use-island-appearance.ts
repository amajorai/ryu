// Reads the island's appearance (background treatment) from the main process.
//
// The value is persisted in Core and written by the desktop's Appearance
// settings. A change to the *window mode* recreates + reloads the window (see
// `main/index.ts`), so a one-shot read on mount always reflects the current
// mode — no live subscription is needed here.

import { useEffect, useState } from "react";
import {
	type IslandBackground,
	parseAppearance,
} from "../../shared/appearance.ts";

/** Current island background: `"translucent"` (default) or `"acrylic"`. */
export function useIslandAppearance(): IslandBackground {
	const [background, setBackground] = useState<IslandBackground>("translucent");

	useEffect(() => {
		let cancelled = false;
		window.island.appearance.get().then((raw) => {
			if (!cancelled) {
				setBackground(parseAppearance(raw).background);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return background;
}
