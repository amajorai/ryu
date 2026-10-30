import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type LimitText, limitIsLikely } from "./game3d-act-stage.tsx";
import { blockerEntries, type OffStage, stageAgents } from "./game3d-acts.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { DoorActs, Season, SeasonDoor } from "./seasonal-model.ts";
import {
	ADVENT_HOUSE,
	PATCH,
	type SeasonWorld,
	type WorldDoor,
} from "./seasonal-world.ts";

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
export function storey(place: WorldDoor): number {
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
