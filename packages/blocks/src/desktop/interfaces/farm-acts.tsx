/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceActivityKind,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Porch, Scarecrow, Sundial } from "./farm-acts-props.tsx";
import {
	NOTICE_SHIFT,
	POST_HEIGHT,
	POST_OUT,
	porchSpots,
} from "./farm-acts-spots.ts";
import type { FarmDiorama, PlacedBed } from "./farm-model.ts";
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

export {
	actGrowth,
	growFocusCrops,
	overripeReplies,
} from "./farm-acts-growth.ts";
export {
	bedsByAgent,
	benchOf,
	farmPaths,
	porchSpots,
} from "./farm-acts-spots.ts";

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
