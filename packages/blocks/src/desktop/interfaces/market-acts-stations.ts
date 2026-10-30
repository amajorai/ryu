import { STATION_LAYOUT, type StationLayout } from "./game3d-act-stage.tsx";
import type {
	MarketFacing,
	MarketLot,
	MarketSquare,
	Vec3,
} from "./market-model.ts";

/** Where a shopkeeper works, and which way its shop faces. */
export interface KeeperStation {
	agentId: string;
	at: Vec3;
	facing: MarketFacing;
	/** Out of the shop, toward the square (unit). */
	front: Vec3;
	id: string;
	/**
	 * The back row's last keeper (furthest right): nobody stands down and to
	 * the right of it, so its alarms can stack down the screen.
	 */
	last: boolean;
	shopId: string;
	/** Along the shop front (unit). */
	side: Vec3;
	/** A team's stall (its front is a counter), not a shop. */
	stall: boolean;
	/** The keeper's own stretch of the front (world units). */
	stretch: number;
	/** From the keeper back to its lot's front: a shop's wall, a stall's counter. */
	wall: number;
}

/**
 * With acts every keeper stands 0.55 before its lot's front (market-model
 * `placeRow`): a shop's wall, or the front face of a stall's counter (so a
 * stall keeper is not hidden behind its counter under the canopy).
 */
const KEEPER_WALL = 0.5;

/** One station per shown shopkeeper (the act layout shows them all). */
export function keeperStations(block: MarketSquare): KeeperStation[] {
	let lastX = Number.NEGATIVE_INFINITY;
	for (const lot of block.lots) {
		if (lot.facing === "south") {
			for (const at of lot.keepers) {
				lastX = Math.max(lastX, at[0]);
			}
		}
	}
	return block.lots.flatMap((lot: MarketLot) =>
		lot.keepers.flatMap((at, index) => {
			const agent = lot.shop.agents[index];
			if (!agent) {
				return [];
			}
			const south = lot.facing === "south";
			const stall = lot.shop.kind === "stall";
			return [
				{
					agentId: agent.id,
					at,
					facing: lot.facing,
					front: (south ? [0, 0, 1] : [1, 0, 0]) as Vec3,
					id: `keeper:${agent.id}`,
					last: south && at[0] === lastX,
					shopId: lot.shop.id,
					side: (south ? [1, 0, 0] : [0, 0, -1]) as Vec3,
					stall,
					stretch: Math.min(
						3.4,
						(lot.size.width - 0.4) / Math.max(1, lot.keepers.length) - 0.3
					),
					wall: KEEPER_WALL,
				},
			];
		})
	);
}

/** A point `along` the shop front and `out` toward the square from a station. */
export function stationOffset(
	station: KeeperStation,
	along: number,
	out: number,
	up = 0
): Vec3 {
	return [
		station.at[0] + station.side[0] * along + station.front[0] * out,
		up,
		station.at[2] + station.side[2] * along + station.front[2] * out,
	];
}

/**
 * The alarms (spec §5: beside the figure, never over it, inside the
 * stage), in one place, with the plates hung explicitly to the right and
 * stacked one plate row (plus `ALARM_GAP`) up the screen each: under the
 * previous keeper's bubble lane, which hangs up and to the right of the
 * keeper up and to the left. The back row's last keeper stacks them down
 * the screen instead, where nobody stands, so a second plate never reaches
 * the bubble of the keeper before it.
 *
 * Wide stages (yaw 45): the beacon is mounted low on the wall behind the
 * keeper, along it to the right, so the first plate sits level with the
 * keeper's name plate and right of it, above the next keeper's plate: clear of the figure and plate
 * (`alarmSideFor` reads it as right), and low enough that a second plate
 * stays under the previous keeper's bubble lane (that keeper stands up and
 * to the left in the back row).
 *
 * Phones (the street turned to yaw 65, plates as icons, keepers 4 apart):
 * screen-right there is 0.42·x − 0.906·z and along the row runs steeply down
 * the screen toward the next keeper, so the beacon steps back (behind the
 * front) rather than along, to hang its icon level with the keeper's plate
 * and a plate's half-width right of it.
 */
function keeperAlarms(station: KeeperStation, narrow: boolean): Vec3 {
	if (station.facing === "east") {
		// In the left row the wall is down and to the left, so the beacon
		// steps further along to stand right of the figure; it lands higher
		// on the screen, which is free there (the next keeper is far along).
		return [1.6 + station.wall, 0, -station.wall];
	}
	return narrow ? [0.9, 1.1, -1.1] : [1.1, 0.6, -station.wall];
}

/**
 * Each further alarm plate's extra climb on top of the kit's plate row
 * (its height plus 4 px), so stacked plates stay the 8 px apart the
 * stage's plate parting keeps (closer, it pushes them apart, over the
 * neighbours' plates): about 5.5 px at the 1280 zoom (~22 px a unit up the
 * screen), 4.7 px on a phone (~7.8).
 */
function alarmGap(narrow: boolean): number {
	return narrow ? 0.6 : 0.25;
}

/**
 * The kit's station layout turned to face a keeper's shop: its x offsets
 * run along the shop front (so they stay inside the keeper's own stretch
 * of it) and its z offsets out into the square. The run cue stays at the
 * keeper's feet. In the left
 * row the openers go on the keeper's -along side (down the screen, away
 * from the lane the previous keeper's bubble hangs in).
 */
export function keeperLayout(
	station: KeeperStation,
	narrow = false
): StationLayout {
	const turn = ([x, y, z]: Vec3): Vec3 => [
		station.side[0] * x + station.front[0] * z,
		y,
		station.side[2] * x + station.front[2] * z,
	];
	const layout = {
		...STATION_LAYOUT,
		...(station.facing === "south" ? KEEPER_LAYOUT : EAST_KEEPER_LAYOUT),
	};
	return {
		alarmRows: station.last ? -1 : 1,
		alarmSide: "right",
		alarmStep: [0, (station.last ? -1 : 1) * alarmGap(narrow), 0],
		alarms: turn(keeperAlarms(station, narrow)),
		board: turn(layout.board),
		cue: turn(layout.cue),
		limit: turn(layout.limit),
		next: turn(layout.next),
		pips: turn(layout.pips),
		suggestion: turn(layout.suggestion),
		unread: turn(layout.unread),
	};
}

/**
 * Where a back-row keeper's props sit, in its shop's frame (x along the
 * front, z out into the square): the crate of pips on the counter before
 * it, the board of words in front, the openers before it to either side
 * and the chalkboard and clock to its left, all inside half the keeper
 * spacing and all below its plate on the screen.
 */
const KEEPER_LAYOUT: Partial<StationLayout> = {
	board: [0, 0, 2.4],
	limit: [-0.7, 0, 0.35],
	next: [-0.95, 0, -0.15],
	pips: [0, 0.34, 0.75],
	suggestion: [-0.95, 0, 1.55],
	unread: [1.5, 0, 0.9],
};

/**
 * A left-row keeper's props: along -x is down the screen there, so the
 * openers stand on that side, clear of the lane above.
 */
const EAST_KEEPER_LAYOUT: Partial<StationLayout> = {
	...KEEPER_LAYOUT,
	suggestion: [-1.3, 0, 2.2],
	unread: [-1.8, 0, 0.8],
};
