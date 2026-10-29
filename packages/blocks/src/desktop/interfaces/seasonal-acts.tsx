/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceActivityKind,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	STATION_LAYOUT,
	type StationLayout,
	type StationNext,
	type TimerSkin,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
	actLife,
	blockerEntries,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	stageAgents,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { NextSign } from "./game3d-signs.tsx";
import type {
	MemberLooks,
	VillagerAccessory,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import type { DoorActs, Season, SeasonDoor } from "./seasonal-model.ts";
import { SEASON_3D, SEASON_ACT_ART } from "./seasonal-palette.ts";
import {
	ADVENT_HOUSE,
	PATCH,
	type SeasonWorld,
	type WorldDoor,
} from "./seasonal-world.ts";

/**
 * The Seasonal board's act layer (spec §5, seasonal row). Each agent's
 * villager stands at the door of its focus thread (the advent house's
 * door or window, its pumpkin in the patch, its lantern on the street),
 * never just its first door. Garlands are its progress pips; an ask is a
 * letter carried to the you-spot (the sleigh mailbox under a little
 * tree on the square, the cauldron at the patch's gate, the post box at the street's
 * end), where a candle melts with the wait; a stopped run frosts its door
 * shut with an icicle tag (a cobweb over the pumpkin, a lantern gone
 * dark); a limit reads "Snowed in, back 15:10" in the season's words; an
 * answer is a wrapped gift set down at the you-spot, tagged with its
 * headline; helpers are dressed as elves (or the season's helpers), and
 * a scheduled next run is tomorrow's door. Opened doors come from the
 * thread's unread count, never from this browser's storage.
 */

/** Where one agent's villager stands: by its focus thread's door. */
export interface SeasonStation {
	agentId: string;
	/** The station's feet point. */
	at: Vec3;
	/**
	 * The patch: the pumpkin on its right is busy, so its tags hang left
	 * and its board stands right (see `PATCH_FLIPPED`).
	 */
	flipped?: boolean;
	id: string;
	/** The focus thread's door number. */
	number: number;
}

/** The season's words for the act layer. */
export interface SeasonActWords {
	/** The limit's words with a reset time ("Snowed in, back 15:10"). */
	limitBack: string;
	/** With no known reset time. */
	limitNone: string;
	/** A villager plate's action suffix (non-asking agents). */
	open: string;
}

export const SEASON_ACT_WORDS: Record<Season, SeasonActWords> = {
	advent: {
		limitBack: "snowed in, back",
		limitNone: "snowed in for now",
		open: "Open their conversation.",
	},
	halloween: {
		limitBack: "fogged in, back",
		limitNone: "fogged in for now",
		open: "Open their conversation.",
	},
	"lunar-new-year": {
		limitBack: "stall shut, back",
		limitNone: "stall shut for now",
		open: "Open their conversation.",
	},
};

/**
 * The limit in the season's words: "Snowed in, back 15:10" (advent),
 * "Fogged in, back 15:10" (the patch), "Stall shut, back 15:10" (the
 * street); "… for now" with no reset time. An estimated limit reads
 * "Likely snowed in, back 15:10" (the kit adds "Likely ").
 */
export function seasonLimit(season: Season): LimitText {
	const words = SEASON_ACT_WORDS[season];
	return (act, clearsAt) => {
		const text = clearsAt ? `${words.limitBack} ${clearsAt}` : words.limitNone;
		return limitIsLikely(act)
			? text
			: `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
	};
}

/**
 * What the act layer says about each thread, for its door's mark and
 * words: a blocking ask needs you (the needs-you mark, as many as the
 * HUD's "need you" counts on the board), a counted stopped run is frosted
 * shut (its own mark), a running act is working, and an unread answer is
 * ready.
 */
export function doorActs(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): DoorActs {
	const needsYou = new Set<string>();
	const stopped = new Set<string>();
	const working = new Set<string>();
	const words = new Map<string, string>();
	for (const ask of snapshot.asks ?? []) {
		if (ask.threadId && ask.blocking) {
			needsYou.add(ask.threadId);
		}
	}
	for (const entry of blockerEntries(snapshot, acts)) {
		if (!needsYou.has(entry.threadId)) {
			stopped.add(entry.threadId);
			words.set(entry.threadId, `stopped: ${entry.blocker.title}`);
		}
	}
	for (const act of acts.values()) {
		const id = act.threadId;
		if (!id || needsYou.has(id) || stopped.has(id)) {
			continue;
		}
		if (act.act === "working") {
			working.add(id);
			words.set(id, act.stalled ? "stalled?" : "working");
		} else if (act.act === "limited") {
			words.set(id, "limited");
		}
	}
	for (const thread of snapshot.threads) {
		if (needsYou.has(thread.id)) {
			words.set(thread.id, "needs you");
		} else if (words.has(thread.id)) {
		} else if ((thread.unread ?? 0) > 0) {
			words.set(thread.id, "answer ready");
		} else if (thread.blocker) {
			// A stop too old to count: said, but not as waiting on you.
			words.set(thread.id, "stopped a while ago");
		} else {
			words.set(thread.id, "quiet");
		}
	}
	return { needsYou, stopped, words, working };
}

/** The advent house's storey of a door (0 ground, 1 middle, 2 top). */
function storey(place: WorldDoor): number {
	const index = ADVENT_HOUSE.rows.findIndex(
		(y) => Math.abs(y - place.at[1]) < 0.01
	);
	return index === -1 ? 0 : index;
}

/**
 * How far out from the advent house a door's villager stands, by storey
 * (ground, middle, top), so the three villagers of one column stand in a
 * line out from it, apart: out in the open square before the front wall
 * (the top windows, the most urgent doors, furthest out, where they read
 * first), close in along the right wall, clear of the tree and the queue.
 */
const ADVENT_FRONT = [1, 2.1, 3.2] as const;
const ADVENT_RIGHT = [2.1, 1.5, 0.9] as const;
/**
 * How far apart the front wall's villagers stand across the square, by
 * storey, as a multiple of the doors' own spacing: the three storeys'
 * villagers of the four columns fan out (the top windows, furthest out,
 * widest) instead of crowding the wall's left half.
 */
const ADVENT_SPREAD = [1.25, 1.6, 1.95] as const;

/**
 * A pumpkin's villager's offset from it (x, z). With the act layer the
 * patch numbers its pumpkins on a checkerboard, so the cell beside each
 * busy pumpkin is free: the villager stands there, its name plate (at
 * head height, above the numbers' height) level with its pumpkin's
 * number and halfway to the next number along, off every number's column
 * (its bubble then hangs clear between the numbers of the row behind).
 */
const HALLOWEEN_STAND: [number, number] = [1.5, -0.7];

/**
 * Where else a door's villager may stand when its place is taken (a
 * neighbour's villager stands too close): a step along at a time.
 */
function standsFor(
	season: Season,
	place: WorldDoor,
	act: InterfaceAgentAct,
	narrow: boolean
): [number, number][] {
	const [x, z] = inFront(season, act)
		? frontStand(place, act)
		: doorStand(season, place, narrow);
	return [0, 1, 2, 3].map((step) => [x + step * 0.9, z]);
}

/**
 * The patch's working and limited villagers stand out in front of the
 * field, beside their pumpkin's column: their boards of words
 * (progress, time, next step: up to three lines; a limit's long line) do
 * not fit the room between the field's numbers, and the open ground there
 * holds them.
 */
const PATCH_FRONT_Z = 5.4;
const PATCH_FRONT_ALONG = 0.6;
/**
 * Odd columns' villagers stand on their pumpkin's left instead, so two
 * neighbours in front of the field stand a bubble's reach apart.
 */
const PATCH_FRONT_ALONG_ODD = -1.6;
/**
 * A limit's long line stands a step further out and one along to the left
 * (level on the screen), clear of the stop tags that hang left of the
 * front pumpkins' villagers.
 */
const PATCH_FRONT_LIMITED = 1;
/** Where a front villager stands (x, z), by its pumpkin's column and act. */
function frontStand(
	place: WorldDoor,
	act: InterfaceAgentAct
): [number, number] {
	const column = Math.round(place.at[0] / PATCH.step + (PATCH.columns - 1) / 2);
	const along = column % 2 === 1 ? PATCH_FRONT_ALONG_ODD : PATCH_FRONT_ALONG;
	const out = act.act === "limited" ? PATCH_FRONT_LIMITED : 0;
	return [place.at[0] + along - out, PATCH_FRONT_Z + out];
}

function inFront(season: Season, act: InterfaceAgentAct): boolean {
	return (
		season === "halloween" && (act.act === "working" || act.act === "limited")
	);
}

/**
 * Whether the pumpkin whose number stands just right of this pumpkin's
 * villager (a column right, a row behind) holds a conversation.
 */
function busyRight(
	place: WorldDoor,
	world: SeasonWorld,
	doors: readonly SeasonDoor[]
): boolean {
	const [x, , z] = place.at;
	const right = world.doors.find(
		(other) =>
			Math.hypot(
				other.at[0] - (x + PATCH.step),
				other.at[2] - (z - PATCH.step)
			) <
			PATCH.step / 2
	);
	return Boolean(right && doors[right.number - 1]?.thread);
}

/** How far apart two villagers' places must be. */
const STAND_APART = 1.1;

/**
 * On a phone the street's camera turns its wires up the screen: a
 * villager stands further out in front of its lantern, so the lantern's
 * number hangs clear above its name.
 */
const STREET_STAND_NARROW: [number, number] = [0.6, 2.4];

/**
 * Where the villager of the door `place` stands, in the season (`narrow`:
 * on a phone's stage).
 */
export function doorStand(
	season: Season,
	place: WorldDoor,
	narrow = false
): [number, number] {
	const [x, , z] = place.at;
	if (season === "halloween") {
		return [x + HALLOWEEN_STAND[0], z + HALLOWEEN_STAND[1]];
	}
	if (season === "lunar-new-year") {
		// In front of its lantern, so the lantern's number hangs just up
		// and to the right of its name.
		const [along, out] = narrow ? STREET_STAND_NARROW : [0.3, 1.7];
		return [x + along, z + out];
	}
	const row = storey(place);
	if (place.yaw !== 0) {
		return [x + (ADVENT_RIGHT[row] ?? 1), z];
	}
	const [centreX] = ADVENT_HOUSE.centre;
	return [
		centreX + (x - centreX) * (ADVENT_SPREAD[row] ?? 1),
		z + (ADVENT_FRONT[row] ?? 1.4),
	];
}

/** The door an agent's villager stands at: its focus thread's, else its first. */
function focusDoor(
	act: InterfaceAgentAct,
	doors: readonly SeasonDoor[]
): SeasonDoor | undefined {
	return (
		doors.find((door) => door.thread && door.thread.id === act.threadId) ??
		doors.find((door) => door.agents.some((agent) => agent.id === act.agentId))
	);
}

/**
 * One station per agent with a door on the board, at its focus thread's
 * door (agents sharing a door stand side by side); agents whose threads
 * are all past the 24th door have none (they are tallied off stage).
 * `narrow`: a phone's stage (icon-only plates).
 */
export function seasonStations(
	season: Season,
	world: SeasonWorld,
	doors: readonly SeasonDoor[],
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	narrow = false
): SeasonStation[] {
	const places = new Map(world.doors.map((door) => [door.number, door]));
	const crowd = new Map<number, number>();
	const stations: SeasonStation[] = [];
	for (const act of acts.values()) {
		const door = focusDoor(act, doors);
		const place = door ? places.get(door.number) : undefined;
		if (!(door && place)) {
			continue;
		}
		const shared = crowd.get(door.number) ?? 0;
		crowd.set(door.number, shared + 1);
		const free = standsFor(season, place, act, narrow).find(
			([x, z]) =>
				!stations.some(
					(other) => Math.hypot(other.at[0] - x, other.at[2] - z) < STAND_APART
				)
		);
		const [x, z] = free ?? standsFor(season, place, act, narrow)[0] ?? [0, 0];
		const at: Vec3 = [x + shared * 0.7, 0, z + shared * 0.7];
		stations.push({
			agentId: act.agentId,
			at,
			...(season === "halloween" &&
			!inFront(season, act) &&
			busyRight(place, world, doors)
				? { flipped: true }
				: {}),
			id: `stand:${act.agentId}`,
			number: door.number,
		});
	}
	return stations;
}

/**
 * Who is on the board: the agents with a station, most urgent first (the
 * kit's stage order, so the overlay budget keeps their words first), and
 * a tally of the rest.
 */
export function boardAgents(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	stations: readonly SeasonStation[]
): { offStage: OffStage; onStage: InterfaceAgentAct[] } {
	const staged = new Set(stations.map((station) => station.agentId));
	const onStage = new Map<string, InterfaceAgentAct>();
	const offStage: OffStage = { asks: 0, byAct: {}, count: 0 };
	for (const act of acts.values()) {
		if (staged.has(act.agentId)) {
			onStage.set(act.agentId, act);
			continue;
		}
		offStage.count += 1;
		offStage.byAct[act.act] = (offStage.byAct[act.act] ?? 0) + 1;
		offStage.asks += (act.ask?.blocking ? 1 : 0) + act.parkedAsks.length;
	}
	return { offStage, onStage: stageAgents(onStage, onStage.size).onStage };
}

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

const YOU_PLANS: Record<Season, YouPlan> = {
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

const ground = ([x, z]: [number, number], y = 0): Vec3 => [x, y, z];

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
function seasonSkin(season: Season): ActSkin {
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

/**
 * Tomorrow's door: where the kit's next sign stands, an agent with a
 * scheduled run gets the season's prop for it (a little closed door, an
 * uncarved pumpkin, an unlit lantern). Only a run counts: an act's next
 * words can name a plan step instead, which keeps the kit's sign.
 */
export function TomorrowDoor({ at, season }: { at: Vec3; season: Season }) {
	const art = SEASON_ACT_ART[season];
	if (season === "halloween") {
		return (
			<group name="tomorrow-door" position={at}>
				<ToonMesh
					castShadow
					color={art.nextDoor}
					ink={0.015}
					position={[0, 0.16, 0]}
					scale={[0.22, 0.16, 0.22]}
				>
					<sphereGeometry args={[1, 12, 8]} />
				</ToonMesh>
				<ToonMesh
					color={art.nextDoorTrim}
					position={[0, 0.35, 0]}
					scale={[0.03, 0.07, 0.03]}
				>
					<cylinderGeometry args={[1, 1, 1, 6]} />
				</ToonMesh>
			</group>
		);
	}
	if (season === "lunar-new-year") {
		return (
			<group name="tomorrow-door" position={at}>
				<ToonMesh
					color={art.nextDoorTrim}
					position={[0, 0.3, 0]}
					scale={[0.025, 0.6, 0.025]}
				>
					<cylinderGeometry args={[1, 1, 1, 6]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={art.nextDoor}
					ink={0.015}
					position={[0, 0.5, 0.08]}
					scale={[0.16, 0.14, 0.16]}
				>
					<sphereGeometry args={[1, 12, 8]} />
				</ToonMesh>
			</group>
		);
	}
	return (
		<group name="tomorrow-door" position={at}>
			<ToonMesh
				castShadow
				color={art.nextDoorTrim}
				ink={0.015}
				position={[0, 0.3, 0]}
				scale={[0.36, 0.6, 0.06]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.nextDoor}
				position={[0, 0.29, 0.02]}
				scale={[0.28, 0.52, 0.04]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.nextDoorTrim}
				position={[0.08, 0.28, 0.05]}
				scale={[0.03, 0.03, 0.03]}
			>
				<sphereGeometry args={[1, 8, 6]} />
			</ToonMesh>
		</group>
	);
}

/**
 * The season's `ActStation renderNext`: tomorrow's door when the agent has
 * a scheduled run (`next.run`), otherwise the kit's sign for its next words.
 */
export function seasonNext(season: Season) {
	return (next: StationNext) =>
		next.run ? (
			<TomorrowDoor at={next.at} season={season} />
		) : (
			<NextSign at={next.at} showText={false} text={next.text} />
		);
}

/** The garlands as progress pips: hung, still to hang, a guess. */
function garlandPips(season: Season) {
	const art = SEASON_ACT_ART[season];
	return { done: art.pipDone, estimate: art.pipEstimate, todo: art.pipTodo };
}

/**
 * One station's layout, `front` units out in front of the villager's feet
 * for its board of words. The icicle tags (alarms) stand beside the
 * figure on its right with their plates hanging further right, never over
 * it; the marks (unread, suggestion) low on its left and in front, out of
 * the lane up and to the right where a neighbour's bubble hangs;
 * tomorrow's door (the next sign) and the limit behind it on the left; the
 * garland pips at its right hand, low.
 */
function stationLayout(
	front: number,
	alarms = STATION_LAYOUT.alarms
): StationLayout {
	return {
		// Screen-right of the figure, the plates hanging further right (the
		// kit's side), one plate row above the last.
		alarmStep: STATION_LAYOUT.alarmStep,
		alarms,
		board: [0, 0.15, front],
		cue: [0, 0.02, 0],
		limit: [-0.45, 0, -0.35],
		next: [-0.5, 0, -0.1],
		pips: [0.4, 0.05, 0.25],
		suggestion: [0.3, 0, front + 0.15],
		unread: [-0.6, 0, 0.3],
	};
}

/** Each season's station layout (the patch and street are roomier). */
const SEASON_LAYOUT: Record<Season, StationLayout> = {
	advent: stationLayout(0.6),
	// The patch's villagers stand in the free cells of its checkerboard, a
	// number on either side of the name: the icicle tags stand on the
	// figure's right (their plates hang right), the board of words low on
	// its left.
	halloween: {
		...stationLayout(0.7),
		board: [-1.1, 0.15, 0.4],
	},
	// On the street the front wire's numbers hang at the figure's left:
	// the unread mark stands low on its right instead.
	// The front wire's villagers stand down and to the right of each other:
	// the alarms stand on the figure's left (their plates hang left).
	"lunar-new-year": {
		...stationLayout(0.5, [-0.75, 0, 0.75]),
		unread: [0.6, 0, 0.5],
	},
};

/**
 * The patch's layout for a villager whose right-hand neighbour pumpkin is
 * busy (its number stands where the tags would hang): the tags stand on
 * the figure's left (under its own pumpkin's number) and the board on its
 * right.
 */
const PATCH_FLIPPED: StationLayout = {
	// Low on the left, its plate under its pumpkin's number.
	...stationLayout(0.7, [-0.8, 0, 1.5]),
	board: [1.1, 0.15, -0.4],
};

/**
 * On a phone (icon-only plates) a station's board of words stands further
 * out in front of the figure, where the stage's steeper, turned portrait
 * look leaves room clear of the neighbours' names and bubbles.
 */
const NARROW_BOARD: Record<Season, StationLayout["board"] | undefined> = {
	advent: [1.0, 0.15, 1.0],
	halloween: [2, 0.15, 0.3],
	"lunar-new-year": [1.4, 0.15, 1.4],
};

/** A station's layout: its season's, or the patch's flipped one. */
function layoutOf(
	season: Season,
	station: SeasonStation,
	iconOnly: boolean
): StationLayout {
	const layout = station.flipped ? PATCH_FLIPPED : SEASON_LAYOUT[season];
	const board = iconOnly ? NARROW_BOARD[season] : undefined;
	return board ? { ...layout, board } : layout;
}

/** The villagers as act villagers (plus their elves). */
export function actVillagers({
	acts,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	season,
	shown,
	slots,
	stations,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	season: Season;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stations: readonly SeasonStation[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	const skin = seasonSkin(season);
	for (const station of stations) {
		const act = acts.get(station.agentId);
		const look = looks.get(station.agentId);
		if (!(act && look)) {
			continue;
		}
		const spots: ActSpots = {
			paths,
			slot: slotOf(slots, act.agentId),
			station: station.id,
			stationFacing: LIFE_FACE_CAMERA,
		};
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && spots.slot ? false : undefined,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} ${SEASON_ACT_WORDS[season].open}`,
			life: actLife(act, spots, skin, { reduced }),
			looks: {
				...look,
				tool:
					act.act === "working"
						? toolForActivity(act.carry, SEASON_TOOLS)
						: undefined,
			},
			name: asking
				? queuePlateText(
						act.agentName,
						{
							approx: asking.sinceApprox,
							since: asking.since,
							until: asking.expiresAt ?? null,
							untilApprox: asking.expiresApprox,
						},
						nowMs
					)
				: act.agentName,
			pose: "idle",
			position: station.at,
			youSpot: asking && spots.slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				dress: seasonHelperDress(season),
				helpers: act.helpers,
				looks: look,
				station: station.at,
			})
		);
	}
	return cast;
}

/** Where the little tree over the sleigh mailbox stands. */
const LITTLE_TREE: Vec3 = [-7.1, 0, 4.4];

/** A little decorated fir: two tiers and a star. */
function LittleTree({ at }: { at: Vec3 }) {
	const art = SEASON_3D.advent;
	return (
		<group position={at}>
			<ToonMesh color={art.timber} position={[0, 0.15, 0]}>
				<cylinderGeometry args={[0.08, 0.1, 0.3, 8]} />
			</ToonMesh>
			{[0, 1].map((tier) => (
				<ToonMesh
					castShadow
					color={art.needles}
					ink={0.015}
					key={tier}
					position={[0, 0.55 + tier * 0.4, 0]}
				>
					<coneGeometry args={[0.6 - tier * 0.18, 0.7, 14]} />
				</ToonMesh>
			))}
			<mesh position={[0, 1.4, 0]} rotation={[0, Math.PI / 4, 0]}>
				<octahedronGeometry args={[0.12, 0]} />
				<meshBasicMaterial color={art.star} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** The sleigh mailbox under the little tree: a red box on runners. */
function SleighMailbox({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART.advent;
	return (
		<group position={at} rotation={[0, Math.PI / 4, 0]}>
			{[-0.2, 0.2].map((x) => (
				<ToonMesh
					color={art.runner}
					ink={0.012}
					key={x}
					position={[x, 0.05, 0]}
					scale={[0.05, 0.05, 0.9]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.38, 0]}
				scale={[0.55, 0.55, 0.7]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={art.postTrim}
				ink={0.01}
				position={[0, 0.5, 0.36]}
				scale={[0.36, 0.06, 0.02]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** The witch's cauldron at the patch's gate, a green glow on top. */
function Cauldron({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART.halloween;
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.34, 0]}
				scale={[0.42, 0.34, 0.42]}
			>
				<sphereGeometry args={[1, 14, 10]} />
			</ToonMesh>
			<mesh position={[0, 0.6, 0]} scale={[0.32, 0.04, 0.32]}>
				<cylinderGeometry args={[1, 1, 1, 14]} />
				<meshBasicMaterial color={art.postTrim} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** The festival post box at the street's end: a green pillar box. */
function PostBox({ at }: { at: Vec3 }) {
	const art = SEASON_ACT_ART["lunar-new-year"];
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={art.post}
				ink={0.02}
				position={[0, 0.5, 0]}
				scale={[0.26, 0.5, 0.26]}
			>
				<cylinderGeometry args={[1, 1, 2, 14]} />
			</ToonMesh>
			<ToonMesh
				color={art.postTrim}
				ink={0.01}
				position={[0, 1.04, 0]}
				scale={[0.3, 0.1, 0.3]}
			>
				<sphereGeometry args={[1, 14, 8]} />
			</ToonMesh>
		</group>
	);
}

/**
 * What covers a stopped run's place: frost over the advent door or window
 * (frosted shut), a cobweb over the pumpkin, a dark cover over the lantern.
 */
function StoppedCover({ place, season }: { place: WorldDoor; season: Season }) {
	const art = SEASON_ACT_ART[season];
	const [x, y, z] = place.at;
	if (season === "advent") {
		const front = place.yaw === 0;
		const tall = storey(place) === 0 ? 1.1 : 0.72;
		return (
			<group position={front ? [x, y, z + 0.06] : [x + 0.06, y, z]}>
				<mesh scale={front ? [0.95, tall, 0.04] : [0.04, tall, 0.95]}>
					<boxGeometry />
					<meshBasicMaterial
						color={art.cover}
						opacity={0.82}
						toneMapped={false}
						transparent
					/>
				</mesh>
				{[-0.3, -0.1, 0.1, 0.3].map((along) => (
					<ToonMesh
						color={art.coverEdge}
						key={along}
						position={
							front
								? [along, tall / 2 - 0.08, 0.04]
								: [0.04, tall / 2 - 0.08, along]
						}
						rotation={[Math.PI, 0, 0]}
						scale={[0.05, 0.22, 0.05]}
					>
						<coneGeometry args={[1, 1, 6]} />
					</ToonMesh>
				))}
			</group>
		);
	}
	if (season === "halloween") {
		// A cobweb strung over the pumpkin: a few pale threads.
		return (
			<group position={[x, 0.55, z]}>
				{[0, Math.PI / 3, (2 * Math.PI) / 3].map((turn) => (
					<ToonMesh
						color={art.cover}
						key={turn}
						rotation={[0, turn, Math.PI / 2]}
						scale={[0.68, 0.68, 0.68]}
					>
						<torusGeometry args={[1, 0.012, 4, 24, Math.PI]} />
					</ToonMesh>
				))}
			</group>
		);
	}
	return (
		<ToonMesh color={art.cover} position={[x, y, z]} scale={[0.4, 0.36, 0.4]}>
			<sphereGeometry args={[1, 14, 10]} />
		</ToonMesh>
	);
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

export interface SeasonActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	reduced: boolean;
	season: Season;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	stations: readonly SeasonStation[];
	/** The stopped runs' doors, to frost shut. */
	stopped: readonly WorldDoor[];
}

/** The act props: the you-spot, each station's cues, the stopped doors. */
export function SeasonActProps({
	acts,
	clock,
	iconOnly,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	reduced,
	season,
	shown,
	slots,
	snapshot,
	stations,
	stopped,
}: SeasonActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	const plan = YOU_PLANS[season];
	const post = ground(plan.post);
	const limitText = seasonLimit(season);
	let mailbox = (
		<>
			<LittleTree at={LITTLE_TREE} />
			<SleighMailbox at={post} />
		</>
	);
	if (season === "halloween") {
		mailbox = <Cauldron at={post} />;
	} else if (season === "lunar-new-year") {
		mailbox = <PostBox at={post} />;
	}
	return (
		<group>
			{mailbox}
			{stopped.map((place) => (
				<StoppedCover key={place.number} place={place} season={season} />
			))}
			<YouSpots
				iconOnly={iconOnly}
				item={seasonSkin(season).deliverable}
				layout={seasonYouLayout(season)}
				nowMs={nowMs}
				offStage={offStage}
				onAsk={onAsk}
				onOpenQueue={onQueue}
				onStage={onStage}
				owners={owners}
				privacy={privacy}
				reduced={reduced}
				shown={shown}
				slots={slots}
				snapshot={snapshot}
				timerSkin={seasonTimerSkin(season)}
				trayTag="headline"
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				return (
					<ActStation
						act={act}
						at={station.at}
						clock={clock}
						iconOnly={iconOnly}
						key={station.id}
						layout={layoutOf(season, station, iconOnly)}
						limitText={limitText}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						pipSkin={garlandPips(season)}
						privacy={privacy}
						reduced={reduced}
						renderNext={seasonNext(season)}
						shown={shown}
						snapshot={snapshot}
					/>
				);
			})}
		</group>
	);
}
