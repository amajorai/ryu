import type { StationLayout } from "./game3d-act-stage.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import {
	BISTRO,
	BISTRO_TOP,
	DESK_TOP,
	deskOffset,
	SCREEN,
	SCREEN_Y,
	SEAT_X,
	SLAB,
} from "./workers-diorama-geometry.ts";
import { CHAIR_OUT, DESK_DEPTH, type OfficeDesk } from "./workers-model.ts";

/**
 * Where a desk's act props sit, in its own frame (the chair toward +z):
 * the plan pips as the bar under the monitor, the next-step note on the
 * desk, the board of words at the chair's left (a speech bubble hangs up
 * and right of the name plate), alarms beside the desk's back right
 * corner, hung right in a tight column (behind the desk no figure stands;
 * in front of it or at the chair's left they covered the next desk's
 * worker), unread answers and suggestions on the desk.
 */
const DESK_LAYOUT: Partial<StationLayout> = {
	alarms: deskOffset([1.05, 0, -0.55]),
	alarmSide: "right",
	alarmStep: [0, 0.6, 0],
	board: deskOffset([-0.8, 0.5, 1.25]),
	cue: deskOffset([SEAT_X, 0.02, CHAIR_OUT]),
	limit: deskOffset([0.55, SLAB + DESK_TOP, 0.05]),
	next: deskOffset([
		SCREEN[0] / 2 - 0.05,
		SLAB + SCREEN_Y,
		-DESK_DEPTH / 2 + 0.2,
	]),
	pips: deskOffset([
		0,
		SLAB + SCREEN_Y - SCREEN[1] / 2 - 0.12,
		-DESK_DEPTH / 2 + 0.24,
	]),
	suggestion: deskOffset([-0.6, SLAB + DESK_TOP, 0.25]),
	unread: deskOffset([-0.15, SLAB + DESK_TOP, 0.25]),
};

/**
 * Where a desk's board stands on a phone: further out in front of the
 * chair, below the name plates of the desks around it, which a phone's
 * small office packs in beside the chair.
 */
const PHONE_DESK_LAYOUT: Partial<StationLayout> = {
	...DESK_LAYOUT,
	board: deskOffset([-0.8, 0.5, 3]),
};

/** A desk's layout; a resting worker's mug stands by it in the coffee corner. */
export function deskLayout(
	desk: OfficeDesk,
	rest: Vec3 | null,
	coffee: { x: number; z: number },
	phone = false
): Partial<StationLayout> {
	if (!rest) {
		return phone ? PHONE_DESK_LAYOUT : DESK_LAYOUT;
	}
	// The worker rests in the coffee corner: its mug stands on the bistro
	// table and its words ("Back 15:10") hang beside it, not at the desk:
	// toward the wall (clear of the desks' alarms), or on a phone, where the
	// wall side runs off the stage, out over the back row clear of the name
	// plates crowding the coffee corner.
	const side = phone ? -5 : 0.75;
	return {
		...DESK_LAYOUT,
		board: [rest[0] + side - desk.x, SLAB + 0.5, rest[2] - 0.15 - desk.z],
		limit: [
			coffee.x + BISTRO[0] - desk.x,
			SLAB + BISTRO_TOP,
			coffee.z + BISTRO[1] - desk.z,
		],
	};
}
