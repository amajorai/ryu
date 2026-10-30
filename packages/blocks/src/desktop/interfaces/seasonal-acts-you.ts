import type { InterfaceActivityKind } from "@ryuhq/protocol/interfaces";
import type { TimerSkin, YouSpotLayout } from "./game3d-act-stage.tsx";
import type { ActSkin } from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerAccessory,
	VillagerTool,
} from "./game3d-villager.tsx";
import type { SeasonStation } from "./seasonal-acts-stations.ts";
import type { Season } from "./seasonal-model.ts";
import { SEASON_ACT_ART } from "./seasonal-palette.ts";
import { PATCH } from "./seasonal-world.ts";

/** The you-spot's places, per season (world x, z). */
interface YouPlan {
	/** Hubs the villagers walk through, and which stations use each. */
	hubs: Record<string, [number, number]>;
	offStage: Vec3;
	/** The mailbox (cauldron, post box) the queue lines up at. */
	post: [number, number];
	queue: readonly [number, number][];
	tally: Vec3;
	tray: [number, number, number];
	you: [number, number];
}

export const YOU_PLANS: Record<Season, YouPlan> = {
	// The sleigh mailbox under a little decorated tree at the square's front
	// left: the queue lines up from it along the front of the square, each
	// place further right and further down the screen than the one before
	// (apart both ways, so the plates never stack), clear of the cast
	// standing out from the house.
	advent: {
		hubs: { corner: [3.2, 3.2] },
		offStage: [7.6, 0.5, 2.4],
		post: [-6.8, 5.6],
		queue: [
			[-5.4, 6.6],
			[-1.8, 6.6],
			[1.8, 6.6],
			[5.4, 6.6],
		],
		tally: [7.4, 0.5, 4.6],
		tray: [6.4, 0.05, 3.6],
		you: [-0.2, 5.8],
	},
	// The scarecrow's cauldron in the yard behind the field (the scarecrow
	// stands at 1.6, -5.9): the queue lines up from the yard's left end,
	// through the back gate, to the furrow behind the field's back row
	// (between two pumpkins' numbers), each place further right and down
	// the screen than the one before. It steps down more than across, so
	// its tail stands well inside a phone's frame.
	halloween: {
		hubs: { yard: [0, -5.3] },
		offStage: [-0.6, 0.5, -8.3],
		post: [0, -6.6],
		queue: [
			[-9, -5.6],
			[-4.4, -5.7],
			[-0.65, -4.95],
			[3.3, -4.4],
		],
		tally: [-5.2, 0.5, -8.2],
		// Up and left of the queue's tail, clear of its plate.
		tray: [2.4, 0.05, -7.7],
		you: [0, -5.6],
	},
	// The post box in the middle of the street, behind the cast under the
	// busy front wires (the back wires' empty lanterns carry no badges):
	// the queue lines up from it along the street, each place further right
	// and further down the screen than the one before (apart both ways).
	"lunar-new-year": {
		hubs: { gap: [0, 3.4] },
		offStage: [-4.4, 0.5, 6.6],
		post: [-5.4, -1.6],
		queue: [
			[-3.6, -1.4],
			[0, -1.4],
			[3.6, -1.4],
			[7.2, -1.4],
		],
		tally: [9, 0.5, 1.6],
		tray: [6.8, 0.05, 1.8],
		you: [-1.8, -0.4],
	},
};

export const ground = ([x, z]: [number, number], y = 0): Vec3 => [x, y, z];

/** The you-spot's waypoints: "you", "you-1".."you-4" and "you-tray". */
export function youPoints(season: Season): Record<string, Vec3> {
	const plan = YOU_PLANS[season];
	const points: Record<string, Vec3> = {
		you: ground(plan.you),
		"you-tray": [plan.tray[0] - 0.6, 0, plan.tray[2] - 0.2],
	};
	for (const [index, spot] of plan.queue.entries()) {
		points[`you-${index + 1}`] = ground(spot);
	}
	for (const [id, spot] of Object.entries(plan.hubs)) {
		points[id] = ground(spot);
	}
	return points;
}

/** The patch's rows (z) and the aisle between the middle columns. */
function patchRowZ(row: number): number {
	return ((PATCH.rows - 1) / 2 - row) * PATCH.step;
}

/** The season's walks: each station to the you-spot, round what is in the way. */
export function seasonActPaths(
	season: Season,
	stations: readonly SeasonStation[]
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(season) };
	const links: [string, string][] = [
		["you", "you-1"],
		["you", "you-2"],
		["you", "you-3"],
		["you", "you-4"],
		["you", "you-tray"],
	];
	if (season === "halloween") {
		// Along its furrow to the middle aisle, up it and over the back fence.
		let previous = "yard";
		links.push(["yard", "you"]);
		for (let row = PATCH.rows; row >= 0; row--) {
			const id = `aisle-${row}`;
			points[id] = [0, 0, patchRowZ(row) + PATCH.step / 2];
			links.push([previous, id]);
			previous = id;
		}
	} else if (season === "advent") {
		// The right wall's villagers come round the house's front corner.
		links.push(["corner", "you"]);
	} else {
		// Out between the middle stalls to their front.
		links.push(["gap", "you"]);
	}
	for (const station of stations) {
		points[station.id] = station.at;
		if (season === "halloween") {
			// The furrow in front of row r is the aisle point `aisle-r`.
			const row = Math.round(
				(PATCH.rows - 1) / 2 - (station.at[2] - PATCH.step / 2) / PATCH.step
			);
			links.push([station.id, `aisle-${Math.max(0, row)}`]);
		} else if (season === "advent" && station.at[2] <= station.at[0]) {
			links.push([station.id, "corner"]);
		} else if (season === "lunar-new-year") {
			links.push([station.id, "gap"]);
		} else {
			links.push([station.id, "you"]);
		}
	}
	return { links, points };
}

/** What a villager holds for its step: a quill to write, a book to read... */
export const SEASON_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	edit: "quill",
	read: "book",
	run: "hammer",
	search: "lens",
	tool: "hammer",
	web: "globe",
	write: "quill",
};

/** The wrapped gift a finished answer is set down as. */
export function seasonSkin(season: Season): ActSkin {
	const art = SEASON_ACT_ART[season];
	return {
		deliverable: {
			accent: art.giftRibbon,
			color: art.gift,
			shape: season === "halloween" ? "bag" : "box",
		},
	};
}

/**
 * The wait timer at the you-spot: a candle on the season's dish, its wax
 * melting with the wait (the kit's candle skin).
 */
export function seasonTimerSkin(season: Season): TimerSkin {
	return { color: SEASON_ACT_ART[season].timer, shape: "candle" };
}

/** The helpers' hats: elves' beanies, straw hats, festival caps. */
const HELPER_HATS: Record<Season, VillagerAccessory> = {
	advent: "beanie",
	halloween: "straw",
	"lunar-new-year": "cap",
};

/**
 * How the season dresses an agent's helpers (`apprenticeSpecs` dress):
 * elves in green with red beanies (advent), the scarecrow's helpers in his
 * purple shirt and a straw hat (halloween), festival helpers in red caps
 * (lunar new year).
 */
export function seasonHelperDress(season: Season): Partial<MemberLooks> {
	const art = SEASON_ACT_ART[season];
	return {
		accent: art.elfAccent,
		accessory: HELPER_HATS[season],
		body: art.elfBody,
		collar: art.elfCollar,
	};
}

/** The you-spot's pieces, from its plan. */
export function seasonYouLayout(season: Season): YouSpotLayout {
	const plan = YOU_PLANS[season];
	const points = youPoints(season);
	const at = (id: string) => points[id] ?? [0, 0, 0];
	return {
		offStage: plan.offStage,
		slots: {
			"you-1": at("you-1"),
			"you-2": at("you-2"),
			"you-3": at("you-3"),
			"you-4": at("you-4"),
		},
		tally: plan.tally,
		tray: plan.tray,
		trayMax: 2,
		trayRowStep: [0.5, 0, 0.5],
		trayStep: [0.55, 0, -0.55],
	};
}
