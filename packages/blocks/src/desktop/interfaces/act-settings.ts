import type { BudgetItem } from "./game3d-acts.ts";
import type { GameKitSettings } from "./game3d-settings.tsx";

/** Station lines a `minimal` overlay density drops (limits and cues stay). */
const MINIMAL_DROPS = /^(?:elapsed|next|progress):/;

/**
 * Whether an act overlay stays under the game kit settings: no work bubbles
 * ("Editing snapshot.ts") when they are off, and no progress, elapsed or
 * next-step lines at a `minimal` density. Asks, alarms, limits and results
 * always stay. Filter the act overlays with it before the budget fills, so a
 * game's own pieces (plates, marquees, boards) agree with the kit's.
 */
export function keepsActOverlay(
	item: Pick<BudgetItem, "id">,
	settings: GameKitSettings
): boolean {
	if (!settings.workBubbles && item.id.startsWith("work:")) {
		return false;
	}
	return !(
		settings.overlayDensity === "minimal" && MINIMAL_DROPS.test(item.id)
	);
}
