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
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actLife,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	toolForActivity,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import type { LifePaths } from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import { PATH_3D, PATH_PIP_SKIN, PATH_TIMER_SKIN } from "./path-palette.ts";
import type { PathWorld, WorldStone } from "./path-world.ts";

/**
 * The path's act layer (spec §5 path row): one hiker per agent stands at
 * its stop (the stone of the thread its act is about). An asking hiker
 * walks back down the trail to the trailhead signpost and queues there,
 * a torch burning down beside it; a delivering one sets a chest on the
 * trailhead and walks back; a limited one rests by its stone under the
 * milestone clock. Each stop is the kit's `ActStation` (the plan's pips as
 * a ring of pebbles round the stone, the words on one board, the fallen
 * log and reason sign for a stopped run, unread answers and suggestions
 * beside it); the trailhead is the kit's `YouSpots`.
 */

/** Hikers' tools per step kind. */
export const PATH_TOOLS: Partial<Record<InterfaceActivityKind, VillagerTool>> =
	{
		edit: "hammer",
		plan: "clipboard",
		read: "book",
		run: "wrench",
		search: "lens",
		write: "quill",
	};

/** A milestone chest is the path's deliverable. */
export const PATH_SKIN: ActSkin = {
	deliverable: {
		accent: PATH_3D.done,
		color: PATH_3D.signPost,
		shape: "box",
	},
};

/** The stepping stone's top above its terrace (path-diorama.tsx `PAD_HEIGHT`). */
const PAD_TOP = 0.32;
/** Where a hiker stands from its stone's centre: just beside it, uphill. */
const HIKER_OUT: Vec3 = [0.55, 0, -0.35];
/** Where a limited hiker rests: on the stone's other side. */
const REST_OUT: Vec3 = [-0.6, 0, 0.25];

/**
 * The trailhead's queue starts well inside the island's front, so its
 * fourth slot still stands on the grass, and steps toward you: on screen
 * each plate sits a plate row (plus the you-spot gap) below the one
 * before, so plate separation has nothing to part.
 */
const QUEUE_FRONT = -4.2;
const SLOT_GAP = 1.7;
const SLOT_STEP = 2.25;
/**
 * How much nearer you a notice stands than a hiker in the same slot, plus
 * how much more for each slot further down the queue: two notices'
 * plates, both low on their posts, need more room than a hiker's over a
 * notice's, and the stage frames the queue whole, so only a wider step
 * between notices (not the whole queue) widens their gap.
 */
const NOTICE_DROP = 0.3;
const NOTICE_SPREAD = 0.15;

/** Each agent's stop: the stone of the thread its act is about, else its latest. */
export function agentStones(
	world: PathWorld,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, WorldStone> {
	const stones = new Map<string, WorldStone>();
	for (const act of acts.values()) {
		const own = world.stones.filter(
			(stone) =>
				stone.stop.agents.some((agent) => agent.id === act.agentId) ||
				stone.stop.thread.agentIds[0] === act.agentId
		);
		const stone =
			own.find((item) => item.stop.thread.id === act.threadId) ?? own.at(-1);
		if (stone) {
			stones.set(act.agentId, stone);
		}
	}
	return stones;
}

const at = (stone: WorldStone, [dx, dy, dz]: Vec3): Vec3 => [
	stone.at[0] + dx,
	stone.y + dy,
	stone.at[1] + dz,
];

/** The trailhead's places: queue slots, the you-spot and the chest. */
export function trailhead(world: PathWorld): {
	slots: Vec3[];
	tray: Vec3;
	you: Vec3;
} {
	// Out in front of the island's first row, left of its middle, clear of
	// the first stops' props and the first unit's sign.
	const [x] = world.trail[0] ?? [0, 0];
	const middle = (world.bounds.minX + world.bounds.maxX) / 2;
	const left = Math.max(x + 1.8, middle - 2.5);
	const front = world.bounds.maxZ + QUEUE_FRONT;
	const slots: Vec3[] = YOU_SLOTS.map((_, index) => [
		left + index * SLOT_GAP,
		0,
		front + index * SLOT_STEP,
	]);
	return {
		slots,
		tray: [left - 2.6, 0, front + 0.9],
		you: [left - 2.2, 0, front - 0.9],
	};
}

/**
 * The hikers' waypoints: each trail point in order, each stop's standing
 * and resting spots joined to the nearest trail point, and the trailhead's
 * slots, you-spot and chest joined to the trail's start.
 */
export function pathPaths(
	world: PathWorld,
	stones: ReadonlyMap<string, WorldStone>
): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	for (const [index, [x, z]] of world.trail.entries()) {
		points[`trail-${index}`] = [x, world.trailHeights[index] ?? 0, z];
		if (index > 0) {
			links.push([`trail-${index - 1}`, `trail-${index}`]);
		}
	}
	const nearest = (x: number, z: number) => {
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const [index, [tx, tz]] of world.trail.entries()) {
			const distance = Math.hypot(tx - x, tz - z);
			if (distance < bestDistance) {
				best = index;
				bestDistance = distance;
			}
		}
		return `trail-${best}`;
	};
	for (const [agentId, stone] of stones) {
		points[`hiker-${agentId}`] = at(stone, [
			HIKER_OUT[0],
			PAD_TOP * 0.5,
			HIKER_OUT[2],
		]);
		points[`rest-${agentId}`] = at(stone, REST_OUT);
		const join = nearest(stone.at[0], stone.at[1]);
		links.push(
			[`hiker-${agentId}`, join],
			[`rest-${agentId}`, join],
			// A short way down to the trailhead, so an ask reaches the queue
			// without walking every bend of the trail.
			[`hiker-${agentId}`, "you"]
		);
	}
	const head = trailhead(world);
	points.you = head.you;
	points["you-tray"] = head.tray;
	links.push(["you", "trail-0"], ["you-tray", "you"]);
	for (const [index, slot] of head.slots.entries()) {
		const id = `you-${index + 1}`;
		points[id] = slot;
		// Each slot joins the trailhead hub (not the slot before it): a hiker
		// moving up the queue walks round it, not through the others.
		links.push([id, "you"]);
	}
	return { links, points };
}

/** The path's words for a limit, under the milestone clock. */
export const pathLimitText: LimitText = (_act, time) =>
	time ? `Resting till ${time}` : "Resting";

/**
 * Where a stop's act props sit, from its stone: the plan's pips in a ring
 * round its front edge, the words on one board up and left of it, the
 * fallen log (alarms) on the trail just ahead (screen-left), the milestone
 * clock by its resting spot, unread answers and suggestions at its front.
 */
const STONE_LAYOUT: Partial<StationLayout> = {
	alarmSide: "right",
	alarms: [1.5, 2.2, -0.5],
	board: [-1.4, 0.1, 0.9],
	cue: [0, PAD_TOP, 0],
	figure: HIKER_OUT,
	limit: [-0.9, 0, 0.6],
	next: [0.35, 0, -0.85],
	pips: [0, PAD_TOP + 0.02, 0.6],
	suggestion: [0.75, 0, 0.55],
	unread: [1.0, 0, 0.5],
};

/**
 * On a phone a front stone's board, left of it, would land in the
 * trailhead queue: it stands at the stone's right instead, unless its
 * hiker rests (on the stone's left, its board beside it).
 */
const PHONE_STONE_LAYOUT: Partial<StationLayout> = {
	...STONE_LAYOUT,
	board: [1.2, 0.1, 0.6],
};

/** The act layer for the diorama, when the host sends asks. */
export interface PathActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: PathActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	stones: ReadonlyMap<string, WorldStone>;
	villagers: VillagerSpec[];
}

/** What the act props need to answer and open cards. */
export interface PathActHandlers {
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	privacy: "full" | "redacted";
	reduced: boolean;
	shown: ReadonlySet<string>;
	snapshot: InterfaceSnapshot;
}

/** The trailhead's you-spot layout: notices on posts, torches, the chest. */
export function trailheadLayout(world: PathWorld): YouSpotLayout {
	const head = trailhead(world);
	// A notice stands a little nearer you than a hiker would in that slot:
	// its plate rides on a post, lower than a hiker's over its head.
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => {
			const point = head.slots[index] ?? head.you;
			const drop = NOTICE_DROP + index * NOTICE_SPREAD;
			return [slot, [point[0] + drop, point[1], point[2] + drop]];
		})
	) as Record<YouSlot, Vec3>;
	return {
		offStage: [head.you[0] - 0.6, 1.9, head.you[2] - 0.4],
		slots,
		tally: [head.you[0] + 0.4, 1.9, head.you[2] - 0.6],
		// Each wait timer stands beside its queued hiker.
		timer: [0.5, 0, 0.2],
		tray: head.tray,
		trayMax: 3,
		trayStep: [-0.35, 0, 0],
	};
}

/**
 * The act props: at each stop the kit's ActStation, at the trailhead the
 * kit's YouSpots. Their plates are scene targets (the path is an IsoStage
 * game: each opens its card from the keyboard too).
 */
export function PathActProps({
	acts,
	handlers,
	offStage,
	onStage,
	owners,
	slots,
	stones,
	world,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: PathActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	stones: ReadonlyMap<string, WorldStone>;
	world: PathWorld;
}) {
	return (
		<group>
			{[...stones].map(([agentId, stone]) => {
				const act = acts.get(agentId);
				if (!act) {
					return null;
				}
				return (
					<ActStation
						act={act}
						at={[stone.at[0], stone.y, stone.at[1]]}
						clock={handlers.clock}
						iconOnly={handlers.iconOnly}
						key={agentId}
						layout={
							handlers.iconOnly && act.act !== "limited"
								? PHONE_STONE_LAYOUT
								: STONE_LAYOUT
						}
						limitText={pathLimitText}
						nowMs={handlers.nowMs}
						onAsk={handlers.onAsk}
						onBlocker={handlers.onBlocker}
						pipSkin={PATH_PIP_SKIN}
						privacy={handlers.privacy}
						reduced={handlers.reduced}
						shown={handlers.shown}
						snapshot={handlers.snapshot}
					/>
				);
			})}
			<YouSpots
				iconOnly={handlers.iconOnly}
				item={PATH_SKIN.deliverable}
				layout={trailheadLayout(world)}
				nowMs={handlers.nowMs}
				offStage={offStage}
				onAsk={handlers.onAsk}
				onOpenQueue={handlers.onQueue}
				onStage={onStage}
				owners={owners}
				privacy={handlers.privacy}
				reduced={handlers.reduced}
				shown={handlers.shown}
				slots={slots}
				snapshot={handlers.snapshot}
				timerSkin={PATH_TIMER_SKIN}
			/>
		</group>
	);
}

/**
 * The hikers: one per agent at its stop, acting out its act on the kit
 * (`actLife`). Each hiker's name plate is its agent's one target, named by
 * the act; an asking hiker's plate answers the ask, and at the trailhead
 * it carries the wait ("Bo · ≤ 7m").
 */
export function pathActVillagers({
	acts,
	looks,
	nowMs,
	onAsk,
	onOpen,
	paths,
	reduced,
	shown,
	slots,
	stones,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	/** Opens the hiker's stop (its thread). */
	onOpen: (threadId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stones: ReadonlyMap<string, WorldStone>;
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const [agentId, stone] of stones) {
		const act = acts.get(agentId);
		const base = looks.get(agentId);
		if (!(act && base)) {
			continue;
		}
		const slot = slotOf(slots, agentId);
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		// An asking hiker starts in its queue slot (a fresh page shows the
		// queue in place, not a walk down the whole trail).
		const position =
			(asking && slot ? paths.points[slot] : undefined) ??
			paths.points[`hiker-${agentId}`] ??
			at(stone, HIKER_OUT);
		const threadId = stone.stop.thread.id;
		cast.push({
			activate: asking ? () => onAsk(asking.id) : () => onOpen(threadId),
			actAgent: agentId,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && slot ? false : undefined,
			id: `hiker:${agentId}`,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Open their stop.`,
			life: actLife(
				act,
				{
					paths,
					rest: `rest-${agentId}`,
					slot,
					station: `hiker-${agentId}`,
				},
				PATH_SKIN,
				{ reduced }
			),
			looks: {
				...base,
				tool:
					act.act === "working" && !act.stalled
						? toolForActivity(act.carry, PATH_TOOLS)
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
			position,
			youSpot: asking && slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId,
				helpers: act.helpers,
				looks: base,
				station: at(stone, [HIKER_OUT[0] + 0.45, 0, HIKER_OUT[2] + 0.4]),
			})
		);
	}
	return cast;
}
