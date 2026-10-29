/* eslint-disable react/no-unknown-property */
import {
	type ClockOptions,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { keepsActOverlay } from "./act-settings.ts";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	STATION_LAYOUT,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
	actLife,
	actOverlays,
	blockerEntries,
	bubbleOverlayId,
	type OffStage,
	type OverlayBudget,
	overlayBudget,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import { GAME_KIT_DEFAULTS, type GameKitSettings } from "./game3d-settings.tsx";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import {
	type MarketFacing,
	type MarketLot,
	type MarketShop,
	type MarketSquare,
	shopForThread,
	type Vec3,
} from "./market-model.ts";
import { MARKET_ACT_ART } from "./market-palette.ts";
/**
 * The Market's act layer (spec §5, market row): every shopkeeper keeps one
 * shop and works at a station of its own there; the asks that need you
 * queue at the market cross (the fountain) in front of your own little
 * stall, where delivered answers are set down as wrapped parcels; and the
 * customers waiting at a shop are its upcoming runs.
 */

/** Each agent keeps one shop: the one holding its focus thread, else its first. */
export function actShops(
	shops: readonly MarketShop[],
	acts: ReadonlyMap<string, InterfaceAgentAct>
): MarketShop[] {
	const home = new Map<string, string>();
	for (const act of acts.values()) {
		const keeps = shops.filter((shop) =>
			shop.agents.some((agent) => agent.id === act.agentId)
		);
		const owner = shopForThread([...keeps], act.threadId);
		const chosen = owner ?? keeps[0];
		if (chosen) {
			home.set(act.agentId, chosen.id);
		}
	}
	return shops.map((shop) => ({
		...shop,
		agents: shop.agents.filter(
			(agent) => (home.get(agent.id) ?? shop.id) === shop.id
		),
	}));
}

/** Each shop's upcoming runs (its keepers' routines), soonest first. */
export function upcomingRuns(
	shops: readonly MarketShop[],
	events: readonly InterfaceEvent[] | undefined
): Map<string, InterfaceEvent[]> {
	const runs = new Map<string, InterfaceEvent[]>();
	const upcoming = (events ?? [])
		.filter((event) => event.kind === "upcoming" && event.agentId)
		.sort((a, b) => a.start.localeCompare(b.start));
	for (const shop of shops) {
		const keepers = new Set(shop.agents.map((agent) => agent.id));
		runs.set(
			shop.id,
			upcoming.filter((event) => keepers.has(event.agentId ?? ""))
		);
	}
	return runs;
}

/** Each shop's blocking asks (those of the shopkeepers it is home to). */
export function shopNeedYou(
	shops: readonly MarketShop[],
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const shop of shops) {
		let count = 0;
		for (const agent of shop.agents) {
			const act = acts.get(agent.id);
			if (act) {
				count += (act.ask?.blocking ? 1 : 0) + act.parkedAsks.length;
			}
		}
		counts.set(shop.id, count);
	}
	return counts;
}

/**
 * Whether an act is live work: working and not stalled (a stalled run may
 * have stopped without Core saying so, so it is never worded as work).
 */
export function worksLive(act: InterfaceAgentAct | undefined): boolean {
	return act?.act === "working" && !act.stalled;
}

/**
 * A shop's door sign from its keepers' acts: "Busy" while one works (live,
 * not stalled), else "Stopped" when one's run is stopped, "Closed for now"
 * when one sits out a limit, else "Open".
 */
export function shopSign(
	shop: MarketShop,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	const keepers = shop.agents.map((agent) => acts.get(agent.id));
	const states = new Set(keepers.map((act) => act?.act));
	if (keepers.some(worksLive)) {
		return "Busy";
	}
	if (states.has("blocked")) {
		return "Stopped";
	}
	return states.has("limited") ? "Closed for now" : "Open";
}

/**
 * Each thread's board section from the acts, not the orders' statuses,
 * where the acts speak to it: a counted stopped run needs attention, a
 * thread waiting on your answer or holding an answer is your turn, and the
 * thread a keeper works on is working, unless its run is stalled: that run
 * may have stopped, so it needs attention (actTotals counts it "stalled?",
 * not working). Every other thread keeps its own status (a keeper's other
 * running threads stay working), except that an older failure the acts no
 * longer count and a reply already read (your turn with no ask) are quiet.
 */
export function actOrderStatuses(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, ThreadStatus> {
	const statuses = new Map<string, ThreadStatus>();
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		statuses.set(
			thread.id,
			status === "attention" || status === "your-turn" ? "quiet" : status
		);
	}
	for (const act of acts.values()) {
		if (act.threadId && act.act === "working") {
			statuses.set(act.threadId, act.stalled ? "attention" : "working");
		}
	}
	for (const ask of snapshot.asks ?? []) {
		if (ask.threadId) {
			statuses.set(ask.threadId, "your-turn");
		}
	}
	for (const entry of blockerEntries(snapshot, acts)) {
		statuses.set(entry.threadId, "attention");
	}
	return statuses;
}

/** A keeper's state in the sheet's words, from its act. */
export function keeperWords(act: InterfaceAgentAct | undefined): string {
	if (!act) {
		return "idle";
	}
	return act.act === "working" && act.stalled
		? "may have stopped"
		: KEEPER_ACT_WORDS[act.act];
}

/** Each act in the sheet's words (a stalled one: `keeperWords`). */
export const KEEPER_ACT_WORDS: Record<InterfaceAgentAct["act"], string> = {
	asking: "asking you",
	blocked: "stopped",
	delivering: "has an answer ready",
	idle: "idle",
	limited: "closed for now",
	waiting: "waiting to start",
	working: "working",
};

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

/** The fountain (the market cross) in the square's middle. */
export function marketCross(block: MarketSquare): Vec3 {
	const { square } = block;
	return [
		(square.minX + square.maxX) / 2 + 0.7,
		0,
		(square.minZ + square.maxZ) / 2 + 0.7,
	];
}

/** The ring of waypoints round the fountain (its basin is 1.05 across). */
export const RING = 1.9;
/** How many waypoints the ring has: a chord stays 1.76 from the middle. */
const RING_POINTS = 8;
/** The queue runs across the screen: along +x and -z (the camera's right). */
const ACROSS: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
/** Toward the camera, into the square's open front corner. */
const TOWARD: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];

function from(origin: Vec3, across: number, toward: number): Vec3 {
	return [
		origin[0] + ACROSS[0] * across + TOWARD[0] * toward,
		0,
		origin[2] + ACROSS[2] * across + TOWARD[2] * toward,
	];
}

/**
 * The queue at the cross, front first, as (across, toward) from the
 * fountain: "you-1" stands before your stall in front of the fountain and
 * each later place a step up the screen and to the left, round the
 * fountain's left side, every one outside the ring. A queued keeper's
 * bubble hangs up and to the right of its plate, and the place behind
 * stands up and to the left, so it never covers the next plate.
 */
const QUEUE_PLACES: readonly [number, number][] = [
	// The front stands well toward the camera: its bubble clears the back
	// row's station boards by more than the 8 px plate gap.
	[2.6, 8.4],
	[-0.8, 3.9],
	[-3.8, 1.2],
	[-6.8, -1.5],
];
/**
 * On a phone (yaw 65, steeper) "toward" climbs less of the screen and
 * "across" more of it sideways, so each place steps further back: about a
 * plate height and a gap up the screen, its text plate (queue plates keep
 * their words) clear of the one before.
 */
const QUEUE_PLACES_NARROW: readonly [number, number][] = [
	[2.2, 7.6],
	[-0.8, 3.7],
	[-3.8, -0.2],
	[-6.8, -4.1],
];

/**
 * The you-spot by the market cross: "you" (an ask with no queue place left),
 * the queue "you-1".."you-4" (`QUEUE_PLACES`), and "you-tray" before your
 * stall down and to the right of the queue's front; a ring of waypoints
 * round the fountain joins them to a lane out of every shop, so nobody
 * walks through the water.
 */
export function youPoints(
	block: MarketSquare,
	narrow = false
): Record<string, Vec3> {
	const cross = marketCross(block);
	const points: Record<string, Vec3> = {};
	for (let index = 0; index < RING_POINTS; index++) {
		const angle = (index / RING_POINTS) * Math.PI * 2;
		points[`cross-${index}`] = [
			cross[0] + Math.cos(angle) * RING,
			0,
			cross[2] + Math.sin(angle) * RING,
		];
	}
	const places = narrow ? QUEUE_PLACES_NARROW : QUEUE_PLACES;
	for (const [index, [across, toward]] of places.entries()) {
		points[`you-${index + 1}`] = from(cross, across, toward);
	}
	// Level with the queue's front and well to its right: under the bubble
	// that hangs up and to the right of "you-1", and more than the 8 px
	// you-spot gap from its plate, so the stage never parts the tray's plate
	// down over your stall.
	points["you-tray"] = from(cross, 7, 8.4);
	// Where an ask waits with no queue place left: down and to the right of
	// the queue's front, so no queued keeper's bubble hangs over it, and its
	// own bubble passes over the tray.
	points.you = from(cross, 4.6, 10.3);
	return points;
}

/** The ring's waypoint ids, in order round the fountain. */
function ringIds(): string[] {
	return Array.from({ length: RING_POINTS }, (_, index) => `cross-${index}`);
}

/** Your stall at the cross: a little counter behind the tray. */
export function yourStallAt(block: MarketSquare): Vec3 {
	return from(marketCross(block), 7, 8.85);
}

/** How high a queue notice's crate stack stands (world units). */
const NOTICE_LIFT = 0.8;

function lifted([x, y, z]: Vec3): Vec3 {
	return [x, y + NOTICE_LIFT, z];
}

/** The crates a queue notice stands on, `NOTICE_LIFT` tall. */
function NoticeCrates({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			{[0, 1].map((level) => (
				<ToonMesh
					castShadow={level === 0}
					color={MARKET_ACT_ART.crate}
					ink={0.02}
					key={level}
					position={[0, NOTICE_LIFT * ((level + 0.5) / 2), 0]}
					rotation={[0, level * 0.4, 0]}
					scale={[0.62, NOTICE_LIFT / 2 - 0.02, 0.62]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

/** Where the kit's you-spot pieces sit at the cross. */
export function crossLayout(
	block: MarketSquare,
	narrow = false
): YouSpotLayout {
	const points = youPoints(block, narrow);
	const at = (id: string) => points[id] ?? [0, 0, 0];
	const cross = marketCross(block);
	const tray = at("you-tray");
	return {
		// Off-stage keepers wait far left, clear of the queue.
		offStage: from(cross, -4.6, 5.2),
		// A notice is pinned up on a crate stack, so its plate rides at a
		// queued keeper's head height.
		slots: {
			"you-1": lifted(at("you-1")),
			"you-2": lifted(at("you-2")),
			"you-3": lifted(at("you-3")),
			"you-4": lifted(at("you-4")),
		},
		// "+N more" stands on past the end of the queue, to its left.
		tally: [...from(cross, -9.8, -1.5)].map((value, index) =>
			index === 1 ? 0.6 : value
		) as Vec3,
		// The parcels are stacked on the ground just right of your stall, a
		// row along it: their plate hangs above them, beside the stall, so
		// the stall and its counter stay in view.
		tray: [
			tray[0] + TOWARD[0] * 0.45 + ACROSS[0] * 1.3,
			0,
			tray[2] + TOWARD[2] * 0.45 + ACROSS[2] * 1.3,
		],
		trayStep: [ACROSS[0] * 0.55, 0, ACROSS[2] * 0.55],
	};
}

/**
 * The walks: the ring round the fountain (each waypoint to the next), the
 * queue places, the tray and every shop's lane each joined to their nearest
 * ring waypoint, and the queue places to each other in line.
 */
export function marketActPaths(
	block: MarketSquare,
	stations: readonly KeeperStation[],
	narrow = false
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(block, narrow) };
	const ring = ringIds();
	const links: [string, string][] = ring.map((id, index) => [
		id,
		ring[(index + 1) % ring.length] ?? id,
	]);
	const nearest = (point: Vec3): string => {
		let best = ring[0] ?? "cross-0";
		let distance = Number.POSITIVE_INFINITY;
		for (const id of ring) {
			const there = points[id];
			if (!there) {
				continue;
			}
			const apart = Math.hypot(there[0] - point[0], there[2] - point[2]);
			if (apart < distance) {
				distance = apart;
				best = id;
			}
		}
		return best;
	};
	const places = QUEUE_PLACES.map((_, index) => `you-${index + 1}`);
	for (const id of [...places, "you-tray", "you"]) {
		const point = points[id];
		if (point) {
			links.push([id, nearest(point)]);
		}
	}
	for (const [index, id] of places.entries()) {
		const behind = places[index + 1];
		if (behind) {
			links.push([id, behind]);
		}
	}
	for (const station of stations) {
		points[station.id] = station.at;
		const lane = `${station.id}:lane`;
		const out = stationOffset(station, 0, 1.25);
		points[lane] = out;
		links.push([station.id, lane], [lane, nearest(out)]);
	}
	return { links, points };
}

const SKIN: ActSkin = {
	deliverable: {
		accent: MARKET_ACT_ART.parcelString,
		color: MARKET_ACT_ART.parcel,
		shape: "box",
	},
};
export const MARKET_ACT_SKIN = SKIN;

/**
 * What a shopkeeper holds for its step: the ledger to read and think, the
 * scale to run a job, use a tool or hand work on, the quill to write up an
 * order, the lens to search, the clipboard to plan.
 */
export const MARKET_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	delegate: "scale",
	edit: "quill",
	plan: "clipboard",
	read: "ledger",
	run: "scale",
	search: "lens",
	think: "ledger",
	tool: "scale",
	web: "globe",
	write: "quill",
};

/**
 * The limit chalked on the shop's board: "Back 15:10", "Closed for now"
 * with no reset time. An inferred limit reads "Likely back 15:10" (the kit
 * adds "Likely ").
 */
export const chalkedLimit: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `back ${clearsAt}` : "closed for now";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The crate's goods as progress pips: sold, still on the shelf, a guess. */
const CRATE_PIPS = {
	done: MARKET_ACT_ART.pipDone,
	estimate: MARKET_ACT_ART.pipEstimate,
	todo: MARKET_ACT_ART.pipTodo,
} as const;

/**
 * The overlay budget the street runs on, and the status overlays it shows:
 * the kit's `actOverlays` in its fill order, the first keeper working live
 * featured (its bubble first).
 *
 * On a narrow stage no work, done or wait bubble is offered to the budget
 * (the spec drops only ask bubbles there). The street is turned to run
 * down a phone's screen with keepers stacked about 16 px apart sideways
 * and 29 px down, so a 150 px bubble hangs off the stage's right edge
 * (the kit's automatic side picks right there), and to the left or above
 * it covers the next keeper's plate or the queue at the cross. Each
 * keeper's board carries its step and its plate its whole sentence.
 */
export function marketShownOverlays({
	kit = GAME_KIT_DEFAULTS,
	offStage,
	onStage,
	reduced,
	slots,
	width,
}: {
	/** The kit game settings: no work bubbles when off, fewer lines at minimal. */
	kit?: GameKitSettings;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	width: number;
}): { budget: OverlayBudget; shown: Set<string> } {
	const budget = overlayBudget(width, { domTargets: true });
	const featured = onStage.find(worksLive)?.agentId ?? null;
	const items = actOverlays(onStage, slots, offStage, featured, {
		reduced,
	})
		.filter((item) => !(budget.narrow && item.kind === "work-bubble"))
		.filter((item) => keepsActOverlay(item, kit));
	return { budget, shown: budget.fill(items) };
}

/** The shopkeepers as act villagers (plus their helpers). */
export function actKeepers({
	acts,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
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
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stations: readonly KeeperStation[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
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
			id: `${station.shopId}\n${act.agentId}`,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Place an order with ${act.agentName}.`,
			life: actLife(act, spots, SKIN, { reduced }),
			looks: {
				...look,
				tool: worksLive(act)
					? toolForActivity(act.carry, MARKET_TOOLS)
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
				helpers: act.helpers,
				looks: look,
				station: station.at,
			})
		);
	}
	return cast;
}

/** A small counter: your stall at the market cross. */
function YourStall({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh
				castShadow
				color={MARKET_ACT_ART.stallWood}
				ink={0.02}
				position={[0, 0.3, 0]}
				scale={[1.3, 0.6, 0.5]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={MARKET_ACT_ART.stallTop}
				ink={0.015}
				position={[0, 0.63, 0]}
				scale={[1.4, 0.06, 0.6]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={MARKET_ACT_ART.stallCloth}
				ink={0.012}
				position={[0, 0.32, 0.26]}
				scale={[1.2, 0.36, 0.02]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** The crate on the counter that holds a keeper's progress pips. */
function PipCrate({ at }: { at: Vec3 }) {
	return (
		<ToonMesh
			castShadow
			color={MARKET_ACT_ART.crate}
			ink={0.02}
			position={[at[0], at[1] - 0.17, at[2]]}
			scale={[0.95, 0.3, 0.42]}
		>
			<boxGeometry />
		</ToonMesh>
	);
}

/**
 * A blocked keeper's shutter, pulled half down across its own stretch of
 * the lot's front, wider than the keeper and its plate so it shows to both
 * sides of them (the alarm plate is the reason sign). At a shop it closes
 * the lower half of the shopfront behind the keeper (the awning hides the
 * wall above about 0.85 from the camera's pitch); at a stall, the
 * counter's front behind the keeper.
 */
function HalfShutter({ station }: { station: KeeperStation }) {
	const yaw = station.facing === "south" ? 0 : Math.PI / 2;
	const { stall } = station;
	// On the shop's wall, or on the stall counter's front face.
	const back = stationOffset(station, 0, -station.wall, 0);
	const width = station.stretch;
	const top = stall ? 0.6 : 0.82;
	const bottom = 0.08;
	const height = top - bottom;
	const ribs = [0.2, 0.4, 0.6, 0.8].map(
		(share) => (share - 0.5) * (height - 0.08)
	);
	return (
		<group
			position={[back[0], (top + bottom) / 2, back[2]]}
			rotation={[0, yaw, 0]}
		>
			<ToonMesh
				color={MARKET_ACT_ART.shutter}
				ink={0.015}
				scale={[width, height, 0.05]}
			>
				<boxGeometry />
			</ToonMesh>
			{ribs.map((y) => (
				<ToonMesh
					color={MARKET_ACT_ART.shutterRib}
					key={y}
					position={[0, y, 0.03]}
					scale={[width - 0.02, 0.04, 0.02]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

export interface MarketActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	block: MarketSquare;
	clock?: ClockOptions;
	/** A narrow stage: icon-only plates, and the phone layouts of the cross and stations. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	stations: readonly KeeperStation[];
}

/** The act props: the cross queue, your stall and tray, and each station's cues. */
export function MarketActProps({
	acts,
	block,
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
	shown,
	slots,
	snapshot,
	stations,
}: MarketActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	return (
		<group>
			<YourStall at={yourStallAt(block)} />
			{slots.slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => {
					const at = youPoints(block, iconOnly)[slot.point];
					return at ? <NoticeCrates at={at} key={slot.ask.id} /> : null;
				})}
			<YouSpots
				iconOnly={iconOnly}
				item={SKIN.deliverable}
				layout={crossLayout(block, iconOnly)}
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
				timerSkin={{ color: MARKET_ACT_ART.chalkboard }}
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				const layout = keeperLayout(station, iconOnly);
				const pips = layout.pips;
				return (
					<group key={station.id}>
						{/* The crate stands on every counter; an idle keeper's is empty. */}
						<PipCrate
							at={[station.at[0] + pips[0], pips[1], station.at[2] + pips[2]]}
						/>
						{act.act === "blocked" ? <HalfShutter station={station} /> : null}
						<ActStation
							act={act}
							at={station.at}
							clock={clock}
							iconOnly={iconOnly}
							layout={layout}
							limitText={chalkedLimit}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							pipSkin={CRATE_PIPS}
							privacy={privacy}
							reduced={reduced}
							shown={shown}
							snapshot={snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
