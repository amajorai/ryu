import type { StationLayout, YouSpotLayout } from "./game3d-act-stage.tsx";
import { YOU_SLOTS, type YouSlot } from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The arcade act layer's floor geometry: the floor axes, the you-spot by
 * the prize counter, the waypoints between players, and where each row's
 * station words sit. Re-exported from `arcade-acts.tsx`.
 */

/** A floor point `across` the view (screen right) and `out` toward the camera. */
export function floorPoint(across: number, out: number, y: number): Vec3 {
	const c = Math.SQRT1_2;
	return [across * c + out * c, y, -across * c + out * c];
}

/** The inverse of `floorPoint`: a world point's across and out. */
function acrossOut(x: number, z: number): [number, number] {
	const c = Math.SQRT1_2;
	return [(x - z) * c, (x + z) * c];
}

/** The prize counter's top, above the floor slab (arcade-diorama.tsx). */
const COUNTER_TOP = 0.95;

/**
 * The you-spot in front of the prize counter: four queue slots on a
 * diagonal (each a step right and a step toward the camera), a plate
 * height and more apart on screen, so no two queue plates share a screen
 * row; the you point beside the first; the tray on the counter's top,
 * where answers are left as ticket strips. The off-stage tally stands
 * past the claw, the "+N more" tally past the queue's far end.
 */
export function arcadeYouSpot(
	counter: [number, number],
	y: number,
	portrait: boolean
): { layout: YouSpotLayout; points: Record<string, Vec3> } {
	const [across, out] = acrossOut(counter[0], counter[1]);
	// Both shapes queue in front of the counter, inside the hall's own
	// front aisle; on a phone the slots zig-zag (left, right, left...) a
	// long step in depth apart, so no plate lands on the player before it.
	const slot = (index: number): Vec3 =>
		portrait
			? floorPoint(across - 3 + (index % 2) * 4.6, out + 1.7 + index * 2.1, y)
			: floorPoint(across + 1.8 + index * 2.5, out + 1.3 + index * 1.6, y);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	const tray: Vec3 = [counter[0] + 0.5, y + COUNTER_TOP, counter[1] + 0.12];
	const last = slot(3);
	return {
		layout: {
			offStage: portrait
				? floorPoint(across + 2.6, out - 0.6, y + 0.6)
				: floorPoint(across + 10.4, out - 0.6, y + 0.6),
			slots,
			tally: [last[0] + 0.9, y + 0.6, last[2] - 0.9],
			tray,
			trayStep: [0.45, 0, 0],
		},
		points: {
			...slots,
			you: portrait
				? floorPoint(across - 2, out + 1, y)
				: floorPoint(across + 1.8, out - 1.2, y),
			"you-tray": floorPoint(across, portrait ? out + 0.55 : out - 0.75, y),
		},
	};
}

/**
 * Waypoints: each player's station, a lane in front of its row (rows are
 * the cabinets sharing an `out`), the lanes' west ends joined front to
 * back, and the front lane joined to the you-spot.
 */
export function arcadePaths(
	stations: ReadonlyMap<string, Vec3>,
	you: Record<string, Vec3>,
	y: number
): LifePaths {
	const points: Record<string, Vec3> = { ...you };
	const links: [string, string][] = [
		["you", "you-1"],
		["you-1", "you-2"],
		["you-2", "you-3"],
		["you-3", "you-4"],
		["you", "you-tray"],
		["you-1", "you-tray"],
	];
	const rows = new Map<number, { across: number; id: string }[]>();
	let reach = 0;
	for (const [id, at] of stations) {
		const [across, out] = acrossOut(at[0], at[2]);
		const row = Math.round(out * 10) / 10;
		const list = rows.get(row) ?? [];
		list.push({ across, id });
		rows.set(row, list);
		reach = Math.max(reach, Math.abs(across));
	}
	const outs = [...rows.keys()].sort((a, b) => a - b);
	for (const [index, out] of outs.entries()) {
		const lane = out + 1.4;
		const west = `lane-${index}-w`;
		const east = `lane-${index}-e`;
		points[west] = floorPoint(-reach - 1.2, lane, y);
		points[east] = floorPoint(reach + 1.2, lane, y);
		links.push([west, east]);
		if (index > 0) {
			links.push([`lane-${index - 1}-w`, west], [`lane-${index - 1}-e`, east]);
		}
		for (const { across, id } of rows.get(out) ?? []) {
			const stop = `lane-${index}:${id}`;
			points[stop] = floorPoint(across, lane, y);
			links.push([`station:${id}`, stop], [stop, west], [stop, east]);
		}
		if (index === outs.length - 1) {
			links.push([west, "you"], [east, "you"]);
		}
	}
	for (const [id, at] of stations) {
		points[`station:${id}`] = at;
	}
	return { links, points };
}

/** A point beside a station: `across` and `out` from it. */
export function besideStation(
	station: Vec3,
	across: number,
	out: number
): Vec3 {
	const offset = floorPoint(across, out, 0);
	return [station[0] + offset[0], station[1], station[2] + offset[2]];
}

/**
 * Where a player's station pieces sit, inside its own footprint: right of
 * the player (its cabinet is on its left) and no further out than the
 * aisle's middle, so no prop reaches the next cabinet or the row in front.
 * The station board's words stand in front of the player.
 */
export const ARCADE_STATION_LAYOUT: Partial<StationLayout> = {
	// In front of the player, low in the aisle, hung to the screen-right
	// (set, not left to the kit's auto side, which would centre them):
	// under the next player's name plate and marquee.
	alarmSide: "right",
	alarms: floorPoint(-0.3, 0.9, 0),
	// In front of the player, low (over its head is the work bubble); the
	// act layer's wide aisle keeps it clear of the row in front.
	board: floorPoint(-0.2, 1.6, 0),
	cue: [0, 0.02, 0],
	limit: floorPoint(0.2, 0.9, 0.6),
	next: floorPoint(0.6, -0.75, 0),
	pips: floorPoint(-0.1, 0.6, 0.05),
	suggestion: floorPoint(-0.5, 0.5, 0.25),
	unread: floorPoint(0.55, 0.6, 0),
};

/**
 * A back-row player's station: its words go up, over its own cabinet's
 * sign and its own head, never down over the row in front.
 */
export const ARCADE_STATION_LAYOUT_BACK: Partial<StationLayout> = {
	...ARCADE_STATION_LAYOUT,
	// Up over its own cabinet's sign, hanging right along the back wall:
	// over every head and marquee (set: the auto side would hang them left,
	// over the left neighbour's column).
	alarmSide: "right",
	alarms: floorPoint(-0.95, -0.42, 3.95),
	board: floorPoint(-0.95, -0.42, 4.9),
	limit: floorPoint(0.3, 0.1, 2.55),
	suggestion: floorPoint(0.45, 0.2, 2.2),
	unread: floorPoint(0.6, -0.2, 1.25),
};

/**
 * A middle row's station (halls of three rows or more, a phone's tall
 * hall): its words stay beside the player, in the aisle between its
 * cabinet and the next, neither down on the row in front nor up on the
 * row behind.
 */
export const ARCADE_STATION_LAYOUT_MID: Partial<StationLayout> = {
	...ARCADE_STATION_LAYOUT,
	board: floorPoint(0.5, 0, 1.9),
	limit: floorPoint(0.45, 0.2, 1.4),
	suggestion: floorPoint(0.3, 0.3, 0.6),
	unread: floorPoint(0.45, -0.2, 0.6),
};

/**
 * A middle row's station on a phone: the alarm marks at the player's
 * screen-right in the aisle, and the limit pill down at its front right,
 * off the name plate.
 */
export const ARCADE_STATION_LAYOUT_MID_NARROW: Partial<StationLayout> = {
	...ARCADE_STATION_LAYOUT_MID,
	// The alarm marks at its screen-right, low and out in the aisle: off
	// the figure and under the next player's name plate, even when the
	// hall is framed wider (more in the queue).
	alarms: floorPoint(1.2, 0.75, 0.05),
	// The limit pill at its front right, under its name plate.
	limit: floorPoint(0.6, 1, 0.1),
};

/**
 * Each station's layout by its row: the row nearest the camera keeps its
 * words low, in front; the row against the back wall puts them up, over
 * its own cabinet; any row between keeps them beside its players (in the
 * aisle on a phone, `narrow`).
 */
export function stationLayoutFor(
	stations: ReadonlyMap<string, Vec3>,
	narrow = false
): (at: Vec3) => Partial<StationLayout> {
	const mid = narrow
		? ARCADE_STATION_LAYOUT_MID_NARROW
		: ARCADE_STATION_LAYOUT_MID;
	let front = Number.NEGATIVE_INFINITY;
	let back = Number.POSITIVE_INFINITY;
	for (const [x, , z] of stations.values()) {
		const out = acrossOut(x, z)[1];
		front = Math.max(front, out);
		back = Math.min(back, out);
	}
	// One row (a filtered hall): nothing stands behind, so its words go up
	// over the players' own cabinets, clear of the counter in front.
	if (front - back < 1) {
		return () => ARCADE_STATION_LAYOUT_BACK;
	}
	return (at) => {
		const out = acrossOut(at[0], at[2])[1];
		if (out > front - 1) {
			return ARCADE_STATION_LAYOUT;
		}
		return out < back + 1 ? ARCADE_STATION_LAYOUT_BACK : mid;
	};
}
