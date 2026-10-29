/* eslint-disable react/no-unknown-property */
import {
	type ClockOptions,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import type { FarmDiorama, FarmField, PlacedBed } from "./farm-model.ts";
import { FARM_3D, FARM_PIP_SKIN, FARM_TIMER_SKIN } from "./farm-palette.ts";
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
	isRedBlocker,
	type OffStage,
	slotOf,
	toolForActivity,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { Benches, PROP_INK } from "./game3d-props.tsx";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";

/**
 * The farm's act layer (spec §5 farm row): each farmer acts out its
 * agent's act on the kit (`actLife`). An asking farmer carries its letter
 * (or scroll) to the farmhouse porch by the gate and queues at the mailbox
 * facing you; a delivering farmer sets a basket of its crop on the porch
 * tray and walks back; a limited farmer sits on a bench by the sundial,
 * "Back 15:10". Each bed is the kit's `ActStation` (the plan's pips as a
 * row of leaves behind the bed, the step's words on one board at the bed's
 * far end, alarms inside the bed, unread answers and suggestions at its
 * front) and a withered bed gets a scarecrow with a crow and a red
 * lantern; the gate is the kit's `YouSpots`, its hourglasses on fence posts.
 */

/** Farmers' tools per step kind. */
export const FARM_TOOLS: Partial<Record<InterfaceActivityKind, VillagerTool>> =
	{
		edit: "hoe",
		plan: "clipboard",
		read: "basket",
		run: "can",
		search: "basket",
		write: "hoe",
	};

/** A crate of the crop is the farm's deliverable. */
export const FARM_SKIN: ActSkin = {
	deliverable: { accent: FARM_3D.hay, color: FARM_3D.stake, shape: "box" },
};

/**
 * The queue runs on the lawn past the front bed row toward the porch at
 * the front-right, stepping toward you: on screen each plate sits right of
 * and a plate height plus a gap below the one before (a plate's bubble
 * hangs up and right of it, clear of the next). A notice stands at its own
 * slot shifted right on screen, never back toward the farmer before it.
 */
const QUEUE_FRONT = 0.9;
const SLOT_GAP = 2.0;
/**
 * A notice's plate stands at a post's height, lower than a farmer's: the
 * notice stands right of its slot on screen (+x), away from the farmer
 * queued before it, so its plate never covers that farmer's face.
 */
const NOTICE_SHIFT: Vec3 = [0.8, 0, 0];
const SLOT_STEP = 1.1;
/** Benches by the pond, one per limited farmer (more share the last). */
const BENCHES = 3;
const BENCH_GAP = 1.0;
/** Where a queued farmer's fence post stands, from its slot, and how tall. */
const POST_OUT: Vec3 = [0.55, 0, 0.25];
const POST_HEIGHT = 0.42;
/** The porch deck's top, where the tray's crates stand. */
const DECK_TOP = 0.24;

/** The gate's places: queue slots, the porch (you-spot, tray, mailbox) and the benches. */
export function porchSpots(diorama: FarmDiorama): {
	benches: Vec3[];
	mailbox: Vec3;
	porch: Vec3;
	slots: Vec3[];
	sundial: Vec3;
	tray: Vec3;
	you: Vec3;
} {
	const { bounds, pond } = diorama;
	// From the front edge's middle (well inside a phone's frame) toward
	// the porch at its right.
	const z = bounds.maxZ + QUEUE_FRONT;
	const left = (bounds.minX + bounds.maxX) / 2 + 0.4;
	const slots: Vec3[] = [0, 1, 2, 3].map((index) => [
		left + index * SLOT_GAP,
		0,
		z + index * SLOT_STEP,
	]);
	const last = slots[3] ?? [left, 0, z];
	const porch: Vec3 = [last[0] + 1.6, 0, last[2] - 1.2];
	const benchX = pond.x - pond.radius - 0.7;
	const benches = Array.from(
		{ length: BENCHES },
		(_, index): Vec3 => [benchX, 0, pond.z - BENCH_GAP + index * BENCH_GAP]
	);
	return {
		benches,
		mailbox: [porch[0] - 0.95, 0, porch[2] + 0.45],
		porch,
		slots,
		sundial: [benchX - 0.15, 0, pond.z + BENCH_GAP * 1.9],
		tray: [porch[0] + 0.25, DECK_TOP, porch[2] + 0.3],
		you: [porch[0], 0, porch[2] + 0.75],
	};
}

/** Each agent's bed, by agent id. */
export function bedsByAgent(diorama: FarmDiorama): Map<string, PlacedBed> {
	const beds = new Map<string, PlacedBed>();
	for (const placed of diorama.beds) {
		if (placed.plot.agent) {
			beds.set(placed.plot.agent.id, placed);
		}
	}
	return beds;
}

/** Which bench (a waypoint id) each limited farmer sits on. */
export function benchOf(
	diorama: FarmDiorama,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, string> {
	const benches = new Map<string, string>();
	for (const placed of diorama.beds) {
		const act = placed.plot.agent ? acts.get(placed.plot.agent.id) : undefined;
		if (act?.act === "limited") {
			benches.set(act.agentId, `bench-${Math.min(benches.size, BENCHES - 1)}`);
		}
	}
	return benches;
}

/**
 * The farmers' waypoints: each farmer's spot, straight down (or up) its
 * strip to the earthen path nearest its row (or the front edge), along it
 * to a spine under the barn door, and down the spine to the gate (the
 * porch, the queue slots, the tray); the benches hang off the spine by the pond.
 */
export function farmPaths(diorama: FarmDiorama): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const { barn, bounds } = diorama;
	const spineX = (barn.minX + barn.maxX) / 2;
	const porch = porchSpots(diorama);
	const lanes = [
		...diorama.paths.map((path) => (path.minZ + path.maxZ) / 2),
		bounds.maxZ + 0.2,
	].sort((a, b) => a - b);
	points.you = porch.you;
	points["you-tray"] = [porch.tray[0], 0, porch.tray[2] + 0.55];
	for (const [index, slot] of porch.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	links.push(
		["you", "you-tray"],
		["you", "you-4"],
		["you-4", "you-3"],
		["you-3", "you-2"],
		["you-2", "you-1"]
	);
	// The spine runs from the barn door down to the front edge, then the gate.
	points["spine-top"] = [spineX, 0, diorama.barn.maxZ + 0.4];
	let previous = "spine-top";
	for (const [index, z] of lanes.entries()) {
		const spine = `spine-${index}`;
		points[spine] = [spineX, 0, z];
		links.push([previous, spine]);
		previous = spine;
	}
	links.push([previous, "you"]);
	for (const [index, bench] of porch.benches.entries()) {
		points[`bench-${index}`] = [bench[0], 0, bench[2] + 0.45];
		links.push(["spine-top", `bench-${index}`]);
	}
	for (const placed of diorama.beds) {
		const agent = placed.plot.agent;
		if (!agent) {
			continue;
		}
		const [x, z] = placed.farmer;
		const below = lanes.findIndex((lane) => lane > z);
		const index = below === -1 ? lanes.length - 1 : below;
		const station = `farmer-${agent.id}`;
		const lane = `lane-${agent.id}`;
		points[station] = [x, 0, z];
		points[lane] = [x, 0, lanes[index] ?? z];
		links.push([station, lane], [lane, `spine-${index}`]);
	}
	return { links, points };
}

/** An estimate's growth snaps to twelfths, so it re-grows a crop now and then, not every tick. */
const GROWTH_STEPS = 12;

/**
 * A working act's focus-crop growth (0..1): a plan's exact steps, or an
 * estimate snapped to twelfths (its `done` moves every second); else null.
 */
export function actGrowth(act: InterfaceAgentAct): number | null {
	const progress = act.progress;
	if (!(act.threadId && progress && progress.total > 0)) {
		return null;
	}
	const share = progress.done / progress.total;
	return progress.kind === "estimate"
		? Math.round(share * GROWTH_STEPS) / GROWTH_STEPS
		: share;
}

/** Fallen fruit for a reply waiting by its wait band (0 fresh to 3 stale). */
const FALLEN: Record<ReturnType<typeof waitBand>, number> = {
	expiring: 3,
	fresh: 0,
	long: 2,
	stale: 3,
	unknown: 0,
	waiting: 1,
};

/** How over-ripe each unread reply's crop is, by thread id. */
export function overripeReplies(
	asks: readonly InterfaceAsk[] | undefined,
	nowMs: number
): Map<string, number> {
	const fallen = new Map<string, number>();
	for (const ask of asks ?? []) {
		if (ask.kind !== "reply" || !ask.threadId) {
			continue;
		}
		const band = waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		);
		fallen.set(ask.threadId, FALLEN[band]);
	}
	return fallen;
}

/**
 * The fields with each working farmer's focus crop grown to its plan's
 * steps (`growth`: exact steps, or the kit's estimate, since a guess still
 * grows the crop; a run with no progress at all keeps its own height),
 * and each unread reply's crop over-ripened by how long it has waited.
 */
export function growFocusCrops(
	fields: readonly FarmField[],
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	overripe: ReadonlyMap<string, number> = new Map()
): FarmField[] {
	const growth = new Map<string, number>();
	for (const act of acts.values()) {
		const value = actGrowth(act);
		if (act.threadId && value !== null) {
			growth.set(act.threadId, value);
		}
	}
	if (growth.size === 0 && overripe.size === 0) {
		return [...fields];
	}
	return fields.map((field) => ({
		...field,
		plots: field.plots.map((plot) => {
			const grow = <T extends { thread: { id: string } }>(crop: T) => {
				const value = growth.get(crop.thread.id);
				const fallen = overripe.get(crop.thread.id);
				return {
					...crop,
					...(value === undefined ? {} : { growth: value }),
					...(fallen ? { overripe: fallen } : {}),
				};
			};
			return {
				...plot,
				crops: plot.crops.map(grow),
				planted: plot.planted.map((entry) => ({
					...entry,
					crop: grow(entry.crop),
				})),
			};
		}),
	}));
}

/** The farmers as act villagers (plus the kids who help). */
export function farmActVillagers({
	acts,
	benches,
	diorama,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	shown,
	slots,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** `benchOf`: where each limited farmer sits. */
	benches: ReadonlyMap<string, string>;
	diorama: FarmDiorama;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const placed of diorama.beds) {
		const agent = placed.plot.agent;
		const act = agent ? acts.get(agent.id) : undefined;
		const base = agent ? looks.get(agent.id) : undefined;
		if (!(agent && act && base)) {
			continue;
		}
		const slot = slotOf(slots, act.agentId);
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		const position: Vec3 = [placed.farmer[0], 0, placed.farmer[1]];
		cast.push({
			activate: asking ? () => onAsk(asking.id) : undefined,
			actAgent: act.agentId,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			iconOnly: asking && slot ? false : undefined,
			id: placed.plot.id,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Open their plot.`,
			life: actLife(
				act,
				{
					paths,
					rest: benches.get(act.agentId) ?? "bench-0",
					slot,
					station: `farmer-${agent.id}`,
					// Facing the bed (to its left) while it works.
					stationFacing: act.act === "working" ? -Math.PI / 2.6 : undefined,
				},
				FARM_SKIN,
				{ reduced }
			),
			looks: {
				...base,
				tool:
					act.act === "working" && !act.stalled
						? toolForActivity(act.carry, FARM_TOOLS)
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
				: placed.plot.name,
			pose: "idle",
			position,
			youSpot: asking && slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				helpers: act.helpers,
				looks: base,
				station: [position[0] - 0.4, 0, position[2] + 0.5],
			})
		);
	}
	return cast;
}

/** What the act props need to answer and open cards. */
export interface FarmActHandlers {
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
 * The farm's words for a limit, by the sundial: "Back 15:10" (the kit adds
 * "Likely " for an inferred limit), "Resting" with no reset time.
 */
export const farmLimitText: LimitText = (_act, at) =>
	at ? `Back ${at}` : "Resting";

/**
 * Where a bed's act props sit, from its farmer (who stands at the bed's
 * right end): the pips as a row of leaves behind the bed, the board of
 * words up and left over the bed (its widest line clear of the farmer's
 * plate and of the gate's queue in front), alarms beside the farmer on its
 * right (the kit hangs their plates on that side, so the stack never hides
 * its pose), the chalkboard behind the farmer, unread answers at its left
 * and suggestions at its front right, the limit by its bench.
 */
export function bedLayout(
	placed: PlacedBed,
	bench: Vec3 | null
): Partial<StationLayout> {
	const [fx, fz] = placed.farmer;
	const { bed } = placed;
	const middleX = (bed.minX + bed.maxX) / 2;
	return {
		alarms: [1.2, 0.6, -0.7],
		alarmStep: [0, 0.55, 0],
		// A resting farmer's words stand by its bench, not at the bed.
		board: bench
			? [bench[0] + 0.9 - fx, 0.5, bench[2] + 0.3 - fz]
			: // Up and left of the farmer, so long words grow away from it.
				[middleX - 1.9 - fx, 0.3, bed.minZ - 0.75 - fz],
		cue: [0, 0.02, 0],
		limit: bench
			? [bench[0] + 0.55 - fx, 0, bench[2] + 0.1 - fz]
			: [0.4, 0, -0.5],
		next: [0.05, 0, -0.95],
		pips: [middleX - fx, 0.05, bed.minZ - 0.18 - fz],
		suggestion: [0.4, 0, 0.6],
		unread: [-0.7, 0, 0.3],
	};
}

/** One bed's act props: the kit's ActStation, in farm colours and words. */
export function FarmBedActs({
	act,
	bench,
	handlers,
	placed,
}: {
	act: InterfaceAgentAct;
	/** The bench its farmer sits on when limited. */
	bench: Vec3 | null;
	handlers: FarmActHandlers;
	placed: PlacedBed;
}) {
	const withered = act.blockers.some((blocker) => isRedBlocker(blocker));
	return (
		<group>
			<ActStation
				act={act}
				at={[placed.farmer[0], 0, placed.farmer[1]]}
				clock={handlers.clock}
				iconOnly={handlers.iconOnly}
				layout={bedLayout(placed, bench)}
				limitText={farmLimitText}
				nowMs={handlers.nowMs}
				onAsk={handlers.onAsk}
				onBlocker={handlers.onBlocker}
				pipSkin={FARM_PIP_SKIN}
				privacy={handlers.privacy}
				reduced={handlers.reduced}
				shown={handlers.shown}
				snapshot={handlers.snapshot}
			/>
			{withered ? (
				<Scarecrow at={[placed.bed.minX + 0.35, 0, placed.bed.minZ + 0.3]} />
			) : null}
		</group>
	);
}

/** The gate's you-spot layout: fence-post queue, baskets on the porch tray. */
export function porchLayout(diorama: FarmDiorama): YouSpotLayout {
	const spots = porchSpots(diorama);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => {
			const at = spots.slots[index] ?? spots.you;
			return [
				slot,
				[at[0] + NOTICE_SHIFT[0], 0, at[2] + NOTICE_SHIFT[2]] as Vec3,
			];
		})
	) as Record<YouSlot, Vec3>;
	return {
		offStage: [spots.porch[0] + 1.0, 1.9, spots.porch[2]],
		// Each hourglass stands on a fence post beside its queued farmer.
		timer: [
			POST_OUT[0] - NOTICE_SHIFT[0],
			POST_HEIGHT,
			POST_OUT[2] - NOTICE_SHIFT[2],
		],
		slots,
		tally: [spots.porch[0] - 0.9, 1.9, spots.porch[2] - 0.3],
		tray: spots.tray,
		trayMax: 3,
		trayRowStep: [0, 0.2, 0],
		trayStep: [-0.3, 0, 0],
	};
}

/**
 * The gate's act props: the kit's YouSpots (a notice for each unowned or
 * parked ask, an hourglass on a fence post beside each queued farmer, the
 * tallies, baskets on the porch tray) and the porch, mailbox and gate.
 */
export function FarmPorchActs({
	diorama,
	handlers,
	offStage,
	onStage,
	owners,
	slots,
}: {
	diorama: FarmDiorama;
	handlers: FarmActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}) {
	const spots = porchSpots(diorama);
	return (
		<group>
			<Porch at={spots.porch} mailbox={spots.mailbox} />
			{slots.slots
				.filter((slot) => slot.carrier === "villager")
				.map((slot) => {
					const at = spots.slots[YOU_SLOTS.indexOf(slot.point)] ?? spots.you;
					return (
						<ToonMesh
							castShadow
							color={FARM_3D.stake}
							ink={PROP_INK}
							key={slot.ask.id}
							position={[
								at[0] + POST_OUT[0],
								POST_HEIGHT / 2,
								at[2] + POST_OUT[2],
							]}
						>
							<boxGeometry args={[0.12, POST_HEIGHT, 0.12]} />
						</ToonMesh>
					);
				})}
			<Benches benches={spots.benches.map((at) => ({ at, yaw: 0 }))} />
			<Sundial at={spots.sundial} />
			<YouSpots
				iconOnly={handlers.iconOnly}
				item={FARM_SKIN.deliverable}
				layout={porchLayout(diorama)}
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
				timerSkin={FARM_TIMER_SKIN}
			/>
		</group>
	);
}

/** The farmhouse porch at the you-spot: a deck under a little roof, a mailbox, a gate. */
function Porch({ at, mailbox }: { at: Vec3; mailbox: Vec3 }) {
	return (
		<group>
			<group position={at}>
				<ToonMesh
					castShadow
					color={FARM_3D.porchDeck}
					ink={PROP_INK}
					position={[0, DECK_TOP / 2, 0]}
					receiveShadow
				>
					<boxGeometry args={[1.5, DECK_TOP, 1.0]} />
				</ToonMesh>
				{[-0.65, 0.65].map((x) => (
					<ToonMesh
						castShadow
						color={FARM_3D.porchPost}
						key={x}
						position={[x, DECK_TOP + 0.6, -0.35]}
					>
						<boxGeometry args={[0.08, 1.2, 0.08]} />
					</ToonMesh>
				))}
				<ToonMesh
					castShadow
					color={FARM_3D.porchRoof}
					ink={PROP_INK}
					position={[0, DECK_TOP + 1.5, -0.45]}
					rotation={[0.45, 0, 0]}
				>
					<boxGeometry args={[1.7, 0.08, 0.8]} />
				</ToonMesh>
			</group>
			{/* The mailbox on its post, flag up. */}
			<group position={mailbox}>
				<ToonMesh color={FARM_3D.stake} position={[0, 0.35, 0]}>
					<boxGeometry args={[0.07, 0.7, 0.07]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={FARM_3D.mailbox}
					ink={PROP_INK}
					position={[0, 0.78, 0]}
				>
					<boxGeometry args={[0.22, 0.2, 0.38]} />
				</ToonMesh>
				<ToonMesh color={FARM_3D.mailboxFlag} position={[0.13, 0.9, -0.08]}>
					<boxGeometry args={[0.02, 0.16, 0.08]} />
				</ToonMesh>
			</group>
			{/* The gate: two posts and a swung-open gate beside the porch. */}
			<group position={[at[0] - 1.45, 0, at[2] + 0.1]}>
				{[-0.35, 0.35].map((x) => (
					<ToonMesh color={FARM_3D.gate} key={x} position={[x, 0.36, 0]}>
						<boxGeometry args={[0.08, 0.72, 0.08]} />
					</ToonMesh>
				))}
				<group position={[-0.33, 0, 0]} rotation={[0, 0.9, 0]}>
					{[0.2, 0.5].map((y) => (
						<ToonMesh color={FARM_3D.gate} key={y} position={[0.3, y, 0]}>
							<boxGeometry args={[0.6, 0.06, 0.04]} />
						</ToonMesh>
					))}
				</group>
			</group>
		</group>
	);
}

/** The sundial by the benches. */
function Sundial({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh castShadow color={FARM_3D.sundial} ink={PROP_INK}>
				<cylinderGeometry args={[0.12, 0.16, 0.5, 12]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.sundial} position={[0, 0.27, 0]}>
				<cylinderGeometry args={[0.26, 0.26, 0.05, 20]} />
			</ToonMesh>
			<ToonMesh
				color={FARM_3D.gnomon}
				position={[0, 0.36, 0]}
				rotation={[0, 0, 0.6]}
			>
				<boxGeometry args={[0.03, 0.18, 0.12]} />
			</ToonMesh>
		</group>
	);
}

/** A scarecrow on a withered bed: straw, coat and hat, a red lantern, a crow. */
function Scarecrow({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh color={FARM_3D.stake} position={[0, 0.5, 0]}>
				<boxGeometry args={[0.06, 1.0, 0.06]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.stake} position={[0, 0.78, 0]}>
				<boxGeometry args={[0.7, 0.05, 0.05]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={FARM_3D.scarecrowCoat}
				ink={PROP_INK}
				position={[0, 0.7, 0]}
			>
				<boxGeometry args={[0.3, 0.32, 0.16]} />
			</ToonMesh>
			<ToonMesh color={FARM_3D.straw} position={[0, 0.98, 0]}>
				<sphereGeometry args={[0.12, 10, 8]} />
			</ToonMesh>
			<ToonMesh
				color={FARM_3D.scarecrowHat}
				ink={PROP_INK}
				position={[0, 1.1, 0]}
			>
				<coneGeometry args={[0.18, 0.18, 12]} />
			</ToonMesh>
			{/* The red lantern hangs from its arm; the crow sits on the other. */}
			<ToonMesh color={FARM_3D.lantern} position={[0.32, 0.66, 0]}>
				<boxGeometry args={[0.09, 0.13, 0.09]} />
			</ToonMesh>
			<group position={[-0.3, 0.86, 0]}>
				<ToonMesh color={FARM_3D.crow} ink={PROP_INK}>
					<sphereGeometry args={[0.07, 10, 8]} />
				</ToonMesh>
				<ToonMesh color={FARM_3D.crow} position={[0.06, 0.06, 0]}>
					<sphereGeometry args={[0.045, 8, 6]} />
				</ToonMesh>
			</group>
		</group>
	);
}
