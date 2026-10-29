/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import {
	type ClockOptions,
	clockLabel,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceBlocker,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useRef } from "react";
import type { Group } from "three";
import {
	ActStation,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actLife,
	bubbleOverlayId,
	isRedBlocker,
	type OffStage,
	slotOf,
	toolForActivity,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import {
	type KitchenService,
	type KitchenStation,
	PASS_SLOTS,
} from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { COUNTER_HEIGHT, PROP_INK } from "./kitchen-props.tsx";

/**
 * The kitchen's act layer (spec §5 kitchen row): each chef acts out its
 * agent's act on the kit (`actLife`). An asking chef carries its ticket
 * round to the front of the pass and queues there facing you, and the
 * pass bell rings once as it arrives; a delivering chef sets a plated dish
 * on the pass (its tray) and goes back; working chefs hold the tool for
 * their step (knife to edit, pan to run, the order book to read, ladle to
 * think). Each station is the kit's `ActStation` (plate-layer pips on the
 * counter, its words on one board in the gap beside it, alarms behind the
 * counter, unread and suggestion openers on it) with the limit worded as
 * the kitchen says it: "86'd till 15:10". The pass is the kit's `YouSpots`.
 */

/** Chefs' tools per step kind (the order book stands in for a ticket). */
export const KITCHEN_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	edit: "knife",
	plan: "clipboard",
	read: "book",
	run: "pan",
	search: "book",
	think: "ladle",
	write: "knife",
};

/** A plated dish is the kitchen's deliverable. */
export const KITCHEN_SKIN: ActSkin = { deliverable: { shape: "plate" } };

/** The station counters stand at villager scale (kitchen-diorama.tsx). */
const STATION_SCALE = 0.68;
const COUNTER_Z = 0.72;
const COUNTER_TOP = (COUNTER_HEIGHT + 0.08) * STATION_SCALE;
/** Chefs walk round their counter on this side, then along a lane. */
const SIDE_X = 1.0;
const LANE_Z = 1.65;
/** Chefs queue in front of the pass, facing you; dishes go on from behind. */
const PASS_QUEUE_Z = 0.95;
const PASS_BACK_Z = -0.62;
/**
 * The queue runs along the pass and steps toward you, so on screen each
 * plate sits right of and one plate lower than the one before: a chef's
 * bubble (it hangs up and right of its plate) clears the next plate along.
 * Notices (unowned or parked asks) stand in the queue at their slots;
 * dishes go on the pass's back edge.
 */
const SLOT_GAP = 1.8;
const SLOT_DEPTH = [0, 1.0, 2.0, 3.0] as const;
const PASS_EDGE = 0.28;
/**
 * How far a notice stands left of and behind its slot (its plate is lower
 * than a chef's, so it moves up-left, away from the next chef's plate), and
 * no nearer the pass than `NOTICE_FRONT`.
 */
const NOTICE_LEFT = 0.6;
const NOTICE_BACK = 0.5;
const NOTICE_FRONT = 0.6;

/**
 * Where a chef's station pieces sit (with the act layer stations stand
 * `ACT_SPREAD` farther apart): pips on the counter's front, the words on
 * a board at its chef's left, under its own plate (speech bubbles hang up
 * and right of a plate, so the right side belongs to the chef's bubble),
 * alarms beside the chef on its lower left (the kit hangs their plates on
 * that side, so the stack never hides its kneel), the meshes at its left end, unread and
 * suggestion openers by its front corners (below the plate line).
 */
export const KITCHEN_STATION_LAYOUT: Partial<StationLayout> = {
	alarms: [-1.6, 0, 1.6],
	board: [-1.0, 1.1, 0.2],
	cue: [0, 0.02, 0],
	limit: [-1.1, 0, 0.35],
	next: [-1.1, 0, -0.2],
	pips: [0, COUNTER_TOP * 0.55, COUNTER_Z + 0.36],
	suggestion: [-0.85, 0, 0.6],
	unread: [0.85, 0, 0.6],
};

/**
 * The pass's queue slots (in front of it, staggered), the spot where a
 * chef sets a dish down (behind it) and the you-spot (its open end), in
 * the room's frame.
 */
export function passSpots(service: KitchenService): {
	slots: Vec3[];
	tray: Vec3;
	you: Vec3;
} {
	const { pass } = service.floor;
	const left = pass.x - pass.length / 2 + 1.2;
	const z = pass.z + PASS_QUEUE_Z;
	const gap = Math.min(SLOT_GAP, (pass.length - 1.6) / 3.3);
	const slots: Vec3[] = SLOT_DEPTH.map((depth, index) => [
		left + index * gap,
		0,
		z + depth,
	]);
	return {
		slots,
		tray: [pass.x + pass.length / 2 - 0.55, 0, pass.z + PASS_BACK_Z],
		you: [pass.x + pass.length / 2 - 0.3, 0, z],
	};
}

/**
 * The chefs' waypoints, in world coordinates (`centreZ` and `slab` move
 * the room's frame onto the island): each station, round its counter to a
 * lane in front of its line, the lanes joined by an aisle at the open
 * side, and the front lane to the pass ("you", the slots and the tray).
 */
export function kitchenPaths(
	service: KitchenService,
	centreZ: number,
	slab: number
): LifePaths {
	const at = (x: number, z: number): Vec3 => [x, slab, z - centreZ];
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const aisleX = service.floor.width / 2 - 0.55;
	const rows = new Map<number, KitchenStation[]>();
	for (const station of service.stations) {
		rows.set(station.row, [...(rows.get(station.row) ?? []), station]);
	}
	const rowIds = [...rows.keys()].sort((a, b) => a - b);
	for (const row of rowIds) {
		const line = (rows.get(row) ?? []).sort((a, b) => a.x - b.x);
		const laneZ = (line[0]?.z ?? 0) + LANE_Z;
		const east = `lane-${row}-e`;
		points[east] = at(aisleX, laneZ);
		let previous: string | null = null;
		for (const station of line) {
			const id = `station-${station.index}`;
			const side = `side-${station.index}`;
			const lane = `lane-${row}-${station.index}`;
			points[id] = at(station.x, station.z);
			points[side] = at(station.x + SIDE_X, station.z);
			points[lane] = at(station.x + SIDE_X, laneZ);
			links.push([id, side], [side, lane]);
			if (previous) {
				links.push([previous, lane]);
			}
			previous = lane;
		}
		if (previous) {
			links.push([previous, east]);
		}
	}
	for (const [index, row] of rowIds.entries()) {
		const next = rowIds[index + 1];
		if (next !== undefined) {
			links.push([`lane-${row}-e`, `lane-${next}-e`]);
		}
	}
	const spots = passSpots(service);
	points.you = at(spots.you[0], spots.you[2]);
	points["you-tray"] = at(spots.tray[0], spots.tray[2]);
	for (const [index, slot] of spots.slots.entries()) {
		points[`you-${index + 1}`] = at(slot[0], slot[2]);
	}
	// Round the pass's open end: the aisle, then along its front.
	points["pass-end"] = at(aisleX, service.floor.pass.z + PASS_QUEUE_Z);
	links.push(
		["pass-end", "you"],
		["you", "you-4"],
		["you-4", "you-3"],
		["you-3", "you-2"],
		["you-2", "you-1"]
	);
	const front = rowIds.at(-1);
	if (front !== undefined) {
		const line = rows.get(front) ?? [];
		for (const station of line) {
			links.push([`lane-${front}-${station.index}`, "you-tray"]);
		}
		links.push(
			[`lane-${front}-e`, "pass-end"],
			[`lane-${front}-e`, "you-tray"]
		);
	}
	return { links, points };
}

/** The chefs as act villagers (plus their commis cooks). */
export function kitchenActVillagers({
	acts,
	centreZ,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	service,
	shown,
	slab,
	slots,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	centreZ: number;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	service: KitchenService;
	shown: ReadonlySet<string>;
	slab: number;
	slots: readonly YouSpotSlot[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const station of service.stations) {
		const act = acts.get(station.agent.id);
		const base = looks.get(station.agent.id);
		if (!(act && base)) {
			continue;
		}
		const slot = slotOf(slots, act.agentId);
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		const position: Vec3 = [station.x, slab, station.z - centreZ];
		const chef: MemberLooks = { ...base, accessory: "chef" };
		cast.push({
			activate: asking ? () => onAsk(asking.id) : undefined,
			actAgent: act.agentId,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && slot ? false : undefined,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Open their tickets.`,
			life: actLife(
				act,
				{
					paths,
					slot,
					station: `station-${station.index}`,
					stationFacing: act.act === "working" ? 0 : LIFE_FACE_CAMERA,
				},
				KITCHEN_SKIN,
				{ reduced }
			),
			looks: {
				...chef,
				tool:
					act.act === "working" && !act.stalled
						? toolForActivity(act.carry, KITCHEN_TOOLS)
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
				agentId: act.agentId,
				helpers: act.helpers,
				looks: chef,
				station: position,
			})
		);
	}
	return cast;
}

/** The station's smoke and burnt ring: a red alarm, not just any attention. */
export function stationBurnt(blockers: readonly InterfaceBlocker[]): boolean {
	return blockers.some((blocker) => isRedBlocker(blocker));
}

/**
 * The kitchen's words for a limit: "86'd till 15:10" (when it resets, from
 * the focus rate-limit blocker or the agent's limit), "Likely 86'd till …"
 * for an inferred one, plain "86'd" with no reset time.
 */
export function eightySixed(
	act: InterfaceAgentAct,
	nowMs: number,
	clock?: ClockOptions
): string {
	const blocker = act.blockers.find((item) => item.kind === "rate-limited");
	const clears = blocker?.clearsAt ?? act.timer?.until ?? null;
	const words = clears
		? `86'd till ${clockLabel(clears, nowMs, clock)}`
		: "86'd";
	return blocker?.source === "estimate" ? `Likely ${words}` : words;
}

/** The act as a station shows it: a limited chef's bubble in kitchen words. */
export function kitchenStationAct(
	act: InterfaceAgentAct,
	nowMs: number,
	clock?: ClockOptions
): InterfaceAgentAct {
	if (act.act !== "limited" || !act.bubble) {
		return act;
	}
	return {
		...act,
		bubble: { ...act.bubble, text: eightySixed(act, nowMs, clock) },
	};
}

/** What the act props need to answer and open cards. */
export interface KitchenActHandlers {
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

/**
 * A station's layout: its alarm stack stands beside the chef, away from
 * the room's middle (a station right of the middle stacks on its right,
 * a little behind; the rest on their left, a little in front), so the kit
 * hangs its plates on that side and the kneel shows, clear of the next chef.
 */
function stationLayout(station: KitchenStation): Partial<StationLayout> {
	return station.x > 0
		? { ...KITCHEN_STATION_LAYOUT, alarms: [1.9, 0, -0.9] }
		: KITCHEN_STATION_LAYOUT;
}

/** One chef's station: the kit's ActStation, in the room's frame. */
export function KitchenStationActs({
	act,
	handlers,
	station,
}: {
	act: InterfaceAgentAct;
	handlers: KitchenActHandlers;
	station: KitchenStation;
}) {
	return (
		<ActStation
			act={kitchenStationAct(act, handlers.nowMs, handlers.clock)}
			at={[station.x, 0, station.z]}
			clock={handlers.clock}
			iconOnly={handlers.iconOnly}
			layout={stationLayout(station)}
			nowMs={handlers.nowMs}
			onAsk={handlers.onAsk}
			onBlocker={handlers.onBlocker}
			privacy={handlers.privacy}
			reduced={handlers.reduced}
			shown={handlers.shown}
			snapshot={handlers.snapshot}
		/>
	);
}

/** The pass's you-spot layout, in the room's frame. */
export function passLayout(
	service: KitchenService,
	passTop: number
): YouSpotLayout {
	const spots = passSpots(service);
	// A notice stands in the queue by its slot (see NOTICE_LEFT); a queued
	// chef's hourglass stands beside the chef.
	const front = service.floor.pass.z + NOTICE_FRONT;
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => {
			const at = spots.slots[index] ?? spots.you;
			const z = Math.max(front, at[2] - NOTICE_BACK);
			return [slot, [at[0] - NOTICE_LEFT, at[1], z] as Vec3];
		})
	) as Record<YouSlot, Vec3>;
	return {
		timer: [NOTICE_LEFT + 0.5, 0, NOTICE_BACK + 0.25],
		offStage: [spots.you[0], 1.9, spots.you[2]],
		slots,
		tally: [spots.you[0], 1.9, spots.you[2]],
		tray: [spots.tray[0], passTop, service.floor.pass.z - PASS_EDGE],
		// A pass's worth of dishes along its back edge; more stack on top.
		trayMax: PASS_SLOTS,
		trayRowStep: [0, 0.14, 0],
		trayStep: [-0.75, 0, 0],
	};
}

const RING_SECONDS = 1.2;

/**
 * The pass bell: rings once (a short wobble) when a chef arrives to ask,
 * keyed on the asks carried into the queue (a chef already there with a
 * new ask rings it again); still under reduced motion.
 */
function PassBell({
	at,
	palette,
	reduced,
	ringKey,
}: {
	at: Vec3;
	palette: KitchenPalette;
	reduced: boolean;
	ringKey: string;
}) {
	const bell = useRef<Group>(null);
	const ringing = useRef<number | null>(null);
	const heard = useRef<Set<string> | null>(null);
	useEffect(() => {
		const askers = new Set(ringKey.split("|").filter(Boolean));
		const before = heard.current;
		heard.current = askers;
		if (reduced || before === null) {
			return;
		}
		if ([...askers].some((id) => !before.has(id))) {
			// A chef walks round the pass first: ring as it settles.
			ringing.current = -1;
		}
	}, [reduced, ringKey]);
	useFrame(({ clock, invalidate }) => {
		const group = bell.current;
		const start = ringing.current;
		if (!group || start === null) {
			return;
		}
		if (start < 0) {
			ringing.current = clock.elapsedTime + 2.5;
			invalidate();
			return;
		}
		const t = clock.elapsedTime - start;
		if (t < 0) {
			invalidate();
			return;
		}
		if (t > RING_SECONDS) {
			group.rotation.z = 0;
			ringing.current = null;
			return;
		}
		group.rotation.z = Math.sin(t * 28) * 0.35 * (1 - t / RING_SECONDS);
		invalidate();
	});
	return (
		<group position={at}>
			<ToonMesh
				color={palette.steel}
				ink={PROP_INK}
				position={[0, 0.015, 0]}
				scale={[0.16, 0.03, 0.16]}
			>
				<cylinderGeometry args={[1, 1, 1, 18]} />
			</ToonMesh>
			<group ref={bell}>
				<ToonMesh
					color={palette.lamp}
					ink={PROP_INK}
					position={[0, 0.09, 0]}
					scale={0.1}
				>
					<sphereGeometry args={[1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
				</ToonMesh>
				<ToonMesh color={palette.lamp} position={[0, 0.2, 0]} scale={0.025}>
					<sphereGeometry args={[1, 8, 6]} />
				</ToonMesh>
			</group>
		</group>
	);
}

/**
 * The pass's act props: the kit's YouSpots (notices for unowned or parked
 * asks, an hourglass beside each queued chef, the tallies, plated dishes
 * on the pass for unread answers, no more than the pass holds) and the
 * pass bell.
 */
export function KitchenPassActs({
	handlers,
	offStage,
	onStage,
	owners,
	palette,
	passTop,
	service,
	slots,
}: {
	handlers: KitchenActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	palette: KitchenPalette;
	passTop: number;
	service: KitchenService;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}) {
	const askers = slots.slots
		.filter((slot) => slot.carrier === "villager")
		.map((slot) => slot.ask.id)
		.sort()
		.join("|");
	return (
		<group>
			<YouSpots
				iconOnly={handlers.iconOnly}
				item={KITCHEN_SKIN.deliverable}
				layout={passLayout(service, passTop)}
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
			/>
			<PassBell
				at={[
					service.floor.pass.x - service.floor.pass.length / 2 + 0.3,
					passTop,
					service.floor.pass.z,
				]}
				palette={palette}
				reduced={handlers.reduced}
				ringKey={askers}
			/>
		</group>
	);
}
