import type { InterfaceAsk } from "@ryuhq/protocol/interfaces";
import type { LimitText } from "./game3d-act-stage.tsx";
import { YOU_SLOTS } from "./game3d-acts.ts";
import type { Vec3 } from "./town-art.tsx";
import { HALL_TOP } from "./town-buildings.tsx";
import { LOT, type TownBuilding } from "./town-model.ts";

/** Where City Hall's steps, queue, inbox and tally are, in world units. */
const STEPS_Z = 2.3;
/**
 * The petition queue runs down the plaza from the steps toward you, so on
 * screen each plate sits lower (a row and more apart) and a little right
 * of the one before; a bubble flips to whichever side is clear.
 */
const SLOT_GAP = 0.75;
const SLOT_STEP = 0.75;
export const HALL_SPOTS = {
	slots: YOU_SLOTS.map(
		(_, index) =>
			[0.2 + index * SLOT_GAP, 0.19, STEPS_Z + 0.3 + index * SLOT_STEP] as Vec3
	),
	tally: [0, 1.2, STEPS_Z + 0.7] as Vec3,
	tray: [4.4, 0.19, 4.6] as Vec3,
	you: [0, 0.19, STEPS_Z + 0.75] as Vec3,
};

/** A building's door, where its villager stands (world units). */
export function doorOf(building: TownBuilding): Vec3 {
	return [building.lot.x + LOT * 0.4, 0.19, building.lot.z + LOT * 0.4];
}

/** The town's words for a limit, on the door sign: "Closed till 15:10". */
export const townLimitText: LimitText = (_act, at) =>
	at ? `Closed till ${at}` : "Closed";

/** The oldest blocking ask's wait, for the clock tower (null with none). */
export function oldestBlockingAsk(
	asks: readonly InterfaceAsk[] | undefined
): InterfaceAsk | null {
	let oldest: InterfaceAsk | null = null;
	for (const ask of asks ?? []) {
		if (!(ask.blocking && ask.since)) {
			continue;
		}
		if (!oldest?.since || Date.parse(ask.since) < Date.parse(oldest.since)) {
			oldest = ask;
		}
	}
	return oldest;
}

/** Above the clock tower's spire, clear of its eave: the oldest wait. */
export const CLOCK_TOWER: Vec3 = [0, HALL_TOP + 0.35, -1.35];
