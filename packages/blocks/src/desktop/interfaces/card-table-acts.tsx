import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";

import { type RoomSeat, TABLE } from "./card-table-room.ts";
import type { StationLayout, YouSpotLayout } from "./game3d-act-stage.tsx";
import {
	actOverlays,
	type BudgetItem,
	type OffStage,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerPose,
	VillagerSpec,
} from "./game3d-villager.tsx";

/**
 * The Card Table's act layer (spec §5, card-table row). The players stay in
 * their chairs; what travels is the **card**: an asking agent slides a face
 * up card across the felt to your seat at the near edge (via
 * `actorTarget`), where it waits in the queue beside the dealer's timer
 * chip. Clicking the card (or the seat's plate) opens the ask card; there
 * are no Approve or Reject chips on the felt. Each seat is a kit
 * `ActStation` on the felt in front of the chair: its progress as a stack
 * of chips with a ghost outline up to the total, every counted failure as
 * a folded (face down) card under its alarm whatever the act, a limited
 * player's "sitting out" button, its marks and its status words. A
 * delivered answer's pot is pushed to your seat, and the dealer button by
 * the pot names the next scheduled deal.
 */

/** Screen right and away from the viewer, on the floor (as card-table-room). */
const ACROSS: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
const AWAY: [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2];
/** On the felt, just above it. */
export const FELT_Y = TABLE.height + 0.04;

export function onFelt(across: number, away: number, y = FELT_Y): Vec3 {
	return [
		ACROSS[0] * across + AWAY[0] * away,
		y,
		ACROSS[1] * across + AWAY[1] * away,
	];
}

/** Across the floor between queue places (world units). */
const QUEUE_GAP = 1.35;
/**
 * A phone's queue places (across, toward the viewer): a staggered row of
 * three, and the fourth in front of them, clear of the near right seat.
 */
const NARROW_PLACES: readonly [number, number][] = [
	[-2.6, -3.4],
	[-0.9, -2.3],
	[0.9, -3.4],
	[-0.9, -4.55],
];

/**
 * Your seat at the near edge: "you" at the near rail, the queue "you-1"
 * .."you-4" across the floor just in front of the table (a wide stage's
 * plates alternate low and high, `slotLift`; a phone's places stagger on
 * the floor), and "you-tray" at the near right, where a delivered pot is
 * pushed. Cards arriving here stay at the table's height: held up at your
 * seat.
 */
export function youPoints(narrow = false): Record<string, Vec3> {
	const place = (index: number) => {
		const spot = NARROW_PLACES[index];
		return narrow && spot
			? onFelt(spot[0], spot[1])
			: onFelt((index - 1.5) * QUEUE_GAP, -3.45);
	};
	return {
		you: onFelt(0, -2.4),
		"you-1": place(0),
		"you-2": place(1),
		"you-3": place(2),
		"you-4": place(3),
		"you-tray": onFelt(2.85, -2.3),
	};
}

/** A seat's place on the felt: its chips (where its card starts). */
export function seatSpot(seat: RoomSeat): Vec3 {
	return [seat.chips[0], FELT_Y, seat.chips[1]];
}

export function cardPaths(
	seats: readonly RoomSeat[],
	narrow: boolean
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(narrow) };
	const links: [string, string][] = [];
	for (const seat of seats) {
		points[`seat-${seat.slot}`] = seatSpot(seat);
		links.push([`seat-${seat.slot}`, "you"]);
	}
	return { links, points };
}

/** A seated player's pose for its act (players stay in their chairs). */
export function seatPose(act: InterfaceAgentAct): VillagerPose {
	switch (act.act) {
		case "asking":
			return "needs-you";
		case "blocked":
			return "failed";
		case "working":
			return act.stalled ? "idle" : "working";
		case "waiting":
			return "waiting";
		default:
			return "idle";
	}
}

/** The helpers standing by a seated player's chair. */
export function seatHelpers(
	act: InterfaceAgentAct,
	looks: MemberLooks,
	seat: RoomSeat
): VillagerSpec[] {
	return apprenticeSpecs({
		agentId: act.agentId,
		helpers: act.helpers,
		looks,
		station: [seat.at[0], 0, seat.at[1]],
	});
}

/**
 * The status overlays the card room can show: the kit's list less the
 * bubbles, as the seated players never speak (an ask's words ride its queue
 * plate and the ask card, the work words the seat's status line), so no
 * budget goes to a bubble nobody draws.
 */
export function cardOverlays(
	onStage: readonly InterfaceAgentAct[],
	slots: { overflow: number; slots: readonly YouSpotSlot[] },
	offStage: Pick<OffStage, "count">,
	reduced: boolean
): BudgetItem[] {
	const focus = onStage.find((act) => act.act === "working")?.agentId ?? null;
	return actOverlays(onStage, slots, offStage, focus, { reduced }).filter(
		(item) => item.kind !== "ask-bubble" && item.kind !== "work-bubble"
	);
}

/** Toward the viewer on the floor: down the screen. */
const TOWARD: [number, number] = [-AWAY[0], -AWAY[1]];

/** A seat's screen-outer side on the floor (screen right for the right-hand seats). */
function outerSide(seat: RoomSeat): { right: boolean; side: [number, number] } {
	const right = seat.at[0] * ACROSS[0] + seat.at[1] * ACROSS[1] >= 0;
	return {
		right,
		side: right ? [ACROSS[0], ACROSS[1]] : [-ACROSS[0], -ACROSS[1]],
	};
}

/** A floor point by a seat's chair: `out` to its outer side, `down` toward the viewer. */
function byTheChair(seat: RoomSeat, out: number, down: number): Vec3 {
	const { side } = outerSide(seat);
	return [
		seat.at[0] + side[0] * out + TOWARD[0] * down,
		FLOOR_Y,
		seat.at[1] + side[1] * out + TOWARD[1] * down,
	];
}

/** From the chair out to the first fold, and fold to fold (world units). */
const FOLD_FIRST = 0.7;
const FOLD_GAP = 0.34;
/** How far toward the viewer the folds lie from the chair. */
const FOLD_DOWN = 0.3;

/** A seat's counted failures: a folded card each (an interrupted run or a limit folds none). */
export function countedFolds(act: InterfaceAgentAct): number {
	return act.blockers.filter(
		(blocker) =>
			blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
	).length;
}

/**
 * The card room's own pieces by a seat, on the floor at the outer side of
 * the chair (never on the felt toward the pot, whose plate the far seats
 * flank): a folded card for each counted failure, thrown down beside the
 * chair, the sitting-out button there for a limited player, and the spot
 * just past the folds where the failures' reasons (the alarms) stand.
 */
export function seatFelt(
	seat: RoomSeat,
	folds = 0
): {
	fold: (index: number) => Vec3;
	puck: Vec3;
	reason: Vec3;
} {
	return {
		fold: (index) => byTheChair(seat, FOLD_FIRST + index * FOLD_GAP, FOLD_DOWN),
		puck: byTheChair(seat, FOLD_FIRST, FOLD_DOWN),
		reason: byTheChair(
			seat,
			FOLD_FIRST + Math.max(0, folds - 0.5) * FOLD_GAP + 0.3,
			FOLD_DOWN - 0.25
		),
	};
}

/**
 * Where a seat's pieces sit, as offsets from its chips (the station). The
 * felt in the middle is the pot's, so a seat's words keep to its own side
 * of the table: the alarms stand on the felt just past their folded cards,
 * on the outer side of the chair (the reason by the fold), their plates
 * hanging further out, off the seat's own figure; the status board hangs
 * on the screen-outer side of the chair, below the name plate over the
 * head; the pips and the marks lie on the felt by the chips. The alarm
 * stack keeps the kit's stacking (one plate row per alarm) on every stage.
 * On a narrow stage the outer side is off the frame and the queue fills
 * the felt's near edge: the board goes down past the queue, toward the
 * viewer.
 */
export function seatLayout(
	seat: RoomSeat,
	narrow = false,
	folds = 0
): Partial<StationLayout> {
	const chips = seatSpot(seat);
	// Toward the screen's outer side for this seat.
	const { right, side } = outerSide(seat);
	/** A point by the chair (`out` to the outer side, `down` toward the viewer). */
	const byChair = (out: number, down: number, y: number): Vec3 => [
		seat.at[0] + side[0] * out + TOWARD[0] * down - chips[0],
		y - chips[1],
		seat.at[1] + side[1] * out + TOWARD[1] * down - chips[2],
	];
	// The far seats sit either side of the pot's plate: their words go up
	// beside their name plates instead, over the back of the room.
	const boardAt = (): Vec3 => {
		if (narrow) {
			return byChair(0.75, 1.95, 0.4);
		}
		return seat.slot < 2
			? byChair(1.25, -0.9, 1.45)
			: byChair(1.55, 0.45, 0.75);
	};
	const reason = seatFelt(seat, folds).reason;
	return {
		// Hung outward from the reasons by the folds, off the chair.
		alarmSide: right ? "right" : "left",
		alarms: [reason[0] - chips[0], reason[1] - chips[1], reason[2] - chips[2]],
		// On a phone the queue fills the felt's near edge: the board goes down
		// past it, toward the viewer, on the seat's own side.
		board: boardAt(),
		cue: [0, 0.02, 0],
		figure: byChair(0, 0, 0),
		limit: byChair(0.75, -0.45, 0),
		next: byChair(-0.55, -0.55, 0),
		pips: [0, 0.05, 0],
		suggestion: narrow ? byChair(0.4, 1.3, 0) : byChair(0.95, 1.45, 0),
		unread: narrow ? byChair(0.4, 0.8, 0) : byChair(0.95, 0.8, 0),
	};
}

/** One seated agent and where its chair is. */
export interface ActSeat {
	act: InterfaceAgentAct;
	seat: RoomSeat;
}

/** Where the you-spot pieces sit at your seat. */
export function youLayout(narrow: boolean): YouSpotLayout {
	const points = youPoints(narrow);
	const at = (slot: YouSlot): Vec3 => {
		const [x, y, z] = points[slot] ?? [0, 0, 0];
		return [x, y + slotLift(slot, narrow, "notice"), z];
	};
	const last = at("you-4");
	const tray = points["you-tray"] ?? [0, 0, 0];
	return {
		// The off-stage tally is a HUD button beside the queue button.
		offStage: last,
		slots: {
			"you-1": at("you-1"),
			"you-2": at("you-2"),
			"you-3": at("you-3"),
			"you-4": at("you-4"),
		},
		tally: [
			last[0] + ACROSS[0] * 1.2,
			last[1] + 0.5,
			last[2] + ACROSS[1] * 1.2,
		],
		timer: [ACROSS[0] * 0.42, 0.04, ACROSS[1] * 0.42 + 0.2],
		tray: [tray[0], tray[1], tray[2]],
		trayMax: 2,
		trayRowStep: [AWAY[0] * 0.6, 0, AWAY[1] * 0.6],
		trayStep: [ACROSS[0] * 0.55, 0, ACROSS[1] * 0.55],
	};
}

/**
 * How much higher a queue place's plate rides (world units) for what
 * carries it there. On a wide stage the places stand in one row, closer
 * than a plate is wide, so the plates alternate low and high (a card's
 * plate low, or held up high; a notice pinned low on a short chip stack, or
 * high on a tall one; a notice's plate rides `NOTICE_ABOVE_CARD` above a
 * card's at the same place) and clear each other without the stage nudging
 * them. A phone's places are staggered on the felt instead.
 */
export function slotLift(
	slot: YouSlot | null,
	narrow: boolean,
	carrier: "notice" | "villager" = "villager"
): number {
	if (narrow) {
		return 0;
	}
	const high = slot === "you-2" || slot === "you-4";
	if (carrier === "notice") {
		return high ? HIGH_PLATE - NOTICE_ABOVE_CARD : -NOTICE_ABOVE_CARD;
	}
	return high ? HIGH_PLATE : 0;
}

/** How far a notice's plate rides above a card's plate at one place. */
const NOTICE_ABOVE_CARD = 0.55;
/** How much higher a high place's plate rides than a low one's. */
const HIGH_PLATE = 1.1;
/** The floor's top, where a notice's chip stack stands. */
export const FLOOR_Y = 0.08;
