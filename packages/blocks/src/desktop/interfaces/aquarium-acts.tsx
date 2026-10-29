/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	TANK_FLOOR,
	TANK_SURFACE,
	type TankLayout,
} from "./aquarium-layout.ts";
import {
	ActStation,
	type LimitText,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actorTarget,
	isRedBlocker,
	type OffStage,
	slotOf,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifeBubble, LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The aquarium's act layer (spec §5 aquarium row). Creatures are kit
 * `actorTarget` actors: an asking creature swims to the front glass and
 * taps there in its queue slot; a delivering one drops a shell in the
 * chest by the glass; a stopped one sinks to the sand by its cave; a
 * limited one rests low in its clam; one waiting on its run hovers at the
 * feeder under the surface. Props sit on the sand under each creature's
 * home: pearls (plan pips), the next sign, alarms, unread shells and
 * suggestion notes. Every in-scene plate is a pointer target only; the
 * "Agents in the tank" list and the ask queue carry keyboard access.
 */

/** A shell is the aquarium's deliverable. */
export const AQUARIUM_SKIN: ActSkin = { deliverable: { shape: "bowl" } };

const GLASS_Z = 1.95;
/**
 * The queue lines up along the tank's right-hand glass, past the last
 * homes, from its front corner back: on screen each slot sits higher and
 * to the right of the one before, a plate height and more apart on a
 * phone, and the first ones stay clear of the back row's homes.
 */
const SLOT_GAP = 1.4;
/** How much higher each slot swims than the one before. */
const SLOT_RISE = 0.7;
/** How far in from the right-hand glass the queue swims. */
const GLASS_IN = 1.2;
/** How much lower a notice floats than a queued creature swims. */
const NOTICE_DROP = 0.5;

/** The glass's queue slots, the shell chest and the you-spot. */
export function glassSpots(layout: TankLayout): {
	slots: Vec3[];
	tray: Vec3;
	you: Vec3;
} {
	const x = layout.halfWidth - GLASS_IN;
	const front = GLASS_Z - 0.35;
	// All four slots stay inside the back glass.
	const gap = Math.min(SLOT_GAP, (front + layout.halfDepth - 0.6) / 3);
	// Mid-water, clear of the sand's props below.
	const y = TANK_FLOOR + 1.1;
	return {
		// Each slot also swims higher: on any stage shape the plates step up.
		slots: YOU_SLOTS.map((_, index) => [
			x,
			y + index * SLOT_RISE,
			front - index * gap,
		]),
		// The shell chest on the sand by the front glass, left of the queue.
		tray: [x - 2.6, TANK_FLOOR, GLASS_Z - 0.1],
		you: [x, y + 0.9, front + 0.2],
	};
}

/** The points `actorTarget` places creatures at: homes, clams, the glass. */
export function tankPaths(layout: TankLayout): LifePaths {
	const points: Record<string, Vec3> = {};
	for (const [id, swim] of layout.swims) {
		const [x, , z] = swim.home;
		points[`home-${id}`] = swim.home;
		points[`rest-${id}`] = [x, TANK_FLOOR + 0.3, z];
	}
	const glass = glassSpots(layout);
	points.you = glass.you;
	points["you-tray"] = [glass.tray[0], TANK_FLOOR + 0.5, glass.tray[2]];
	for (const [index, slot] of glass.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	return { links: [], points };
}

/** A creature plate's act words and badge (aquarium-creatures.tsx). */
export interface CreaturePlateAct {
	/** An asking creature's plate answers its ask (§4.1 item 11). */
	activate?: () => void;
	badge: { className: string; mark: string } | null;
	/** The bubble-trail label the budget kept (its work, ask or answer). */
	bubble?: LifeBubble | null;
	/** A queue plate's name and wait ("Bo · ≤ 7m"); else the name. */
	text?: string;
	/** A you-spot queue plate (`data-you-spot="slot"`), for overlap checks. */
	youSpot: boolean;
}

/**
 * The plate badge follows the act, not the thread counts: asking wears the
 * gold "!", a stopped run the red "×", work the blue dots; the rest none.
 */
export function actPlateBadge(
	act: InterfaceAgentAct
): CreaturePlateAct["badge"] {
	if (act.act === "asking") {
		return {
			className: "bg-(--gk-gold) text-(--gk-edge)",
			mark: "!",
		};
	}
	if (act.act === "blocked") {
		// A failed run wears the red ×; an interrupted one a grey pause.
		return act.blockers.some((blocker) => isRedBlocker(blocker))
			? { className: "bg-(--gk-bad) text-(--gk-plate)", mark: "×" }
			: { className: "bg-(--gk-plate-sunk) text-(--gk-ink)", mark: "‖" };
	}
	if (act.act === "working") {
		return { className: "bg-(--gk-info) text-(--gk-plate)", mark: "•••" };
	}
	return null;
}

/** Where a creature swims for its act, and whether it holds near there. */
export interface CreatureTarget {
	at: Vec3;
	/** Away from home (the glass, the chest, the sand): a small, slow loop. */
	away: boolean;
}

/**
 * Each creature's act target: `actorTarget` for asking (its glass slot),
 * delivering (the chest, or home once settled), limited (its clam) and the
 * rest (home); a stopped creature sinks to the sand under its home, and
 * one waiting for its run hovers at the feeder near the surface.
 */
export function creatureTargets(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	layout: TankLayout,
	slots: readonly YouSpotSlot[],
	still: boolean
): Map<string, CreatureTarget> {
	const paths = tankPaths(layout);
	const targets = new Map<string, CreatureTarget>();
	for (const [id, swim] of layout.swims) {
		const act = acts.get(id);
		if (!act) {
			continue;
		}
		const [x, , z] = swim.home;
		if (act.act === "blocked") {
			targets.set(id, { at: [x, TANK_FLOOR + 0.22, z], away: true });
			continue;
		}
		if (act.act === "waiting") {
			targets.set(id, { at: [x, TANK_SURFACE - 0.45, z], away: true });
			continue;
		}
		const target = actorTarget(
			act,
			{
				paths,
				rest: `rest-${id}`,
				slot: slotOf(slots, id),
				station: `home-${id}`,
			},
			still
		);
		targets.set(id, {
			at: target.position,
			away: act.act !== "working" && act.act !== "idle",
		});
	}
	return targets;
}

/** What the act props need to answer and open cards. */
export interface AquariumActHandlers {
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

/** The reef feature a working creature's step grows by its home (spec §5). */
export type ReefKind = "bubbler" | "coral" | "shell";

/**
 * coral = edit (and write), bubbler = run, shell = read (and search); no
 * feature for other or unknown steps (never an edit coral by default).
 */
export function reefKind(act: InterfaceAgentAct): ReefKind | null {
	switch (act.carry) {
		case "edit":
		case "write":
			return "coral";
		case "run":
			return "bubbler";
		case "read":
		case "search":
			return "shell";
		default:
			return null;
	}
}

/** Where the reef feature stands from a home: back left, clear of the props. */
const REEF_OUT: Vec3 = [-0.6, 0, -0.3];

/** A small coral, a bubbler or an open shell on the sand (decorative). */
function ReefFeature({
	at,
	kind,
	palette,
}: {
	at: Vec3;
	kind: ReefKind;
	palette: { bubble: string; coral: string; shell: string };
}) {
	if (kind === "bubbler") {
		return (
			<group position={at}>
				<ToonMesh color={palette.shell} ink={0.02} position={[0, 0.08, 0]}>
					<cylinderGeometry args={[0.07, 0.1, 0.16, 10]} />
				</ToonMesh>
				{[0.32, 0.55, 0.82].map((y, index) => (
					<ToonMesh
						color={palette.bubble}
						key={y}
						position={[index % 2 ? 0.03 : -0.03, y, 0]}
						scale={0.05 + index * 0.012}
					>
						<sphereGeometry args={[1, 10, 8]} />
					</ToonMesh>
				))}
			</group>
		);
	}
	if (kind === "shell") {
		return (
			<group position={at}>
				<ToonMesh
					color={palette.shell}
					ink={0.02}
					position={[0, 0.06, 0]}
					scale={[0.16, 0.07, 0.13]}
				>
					<sphereGeometry args={[1, 14, 10]} />
				</ToonMesh>
				<ToonMesh
					color={palette.shell}
					ink={0.02}
					position={[0, 0.15, -0.08]}
					rotation={[-0.9, 0, 0]}
					scale={[0.16, 0.05, 0.12]}
				>
					<sphereGeometry args={[1, 14, 10]} />
				</ToonMesh>
			</group>
		);
	}
	return (
		<group position={at}>
			{[
				[0, 0.18, 0, 0.3],
				[0.08, 0.12, 0.04, 0.2],
				[-0.07, 0.13, -0.03, 0.22],
			].map(([x, y, z, h]) => (
				<ToonMesh
					color={palette.coral}
					ink={0.02}
					key={`${x}:${z}`}
					position={[x ?? 0, y ?? 0, z ?? 0]}
				>
					<coneGeometry args={[0.05, h ?? 0.2, 7]} />
				</ToonMesh>
			))}
		</group>
	);
}

/** The aquarium's words for a limit, by the clam: "In the clam till 15:10". */
export const aquariumLimitText: LimitText = (_act, at) =>
	at ? `In the clam till ${at}` : "In the clam";

/**
 * Where a creature's act props sit on the sand under its home: the pearl
 * string (plan pips) in front, the castle sign for the next step behind,
 * alarms to its screen-right (the kit's default), the words on one board
 * just in front of and below it (its own, never in a neighbour's lane),
 * the clam's clock in front of it, unread shells and suggestion notes at
 * its front corners, its reef feature behind it.
 */
const SAND_LAYOUT: Partial<StationLayout> = {
	board: [0.1, 0.15, 0.85],
	cue: [0, 0, 0],
	limit: [0.35, 0, 1.15],
	next: [-0.75, 0, -0.2],
	pips: [0, 0.05, 0.55],
	suggestion: [0.6, 0, 0.4],
	unread: [-0.55, 0, 0.45],
};

/**
 * On a phone the homes' plates stack into one column at the tank's left
 * end, so each board moves out to its home's screen-right, over open water.
 */
const PHONE_SAND_LAYOUT: Partial<StationLayout> = {
	...SAND_LAYOUT,
	board: [2.2, 0.15, -0.9],
};

/** The front glass's you-spot layout: floating notices and hourglasses in the queue's line, the chest. */
export function glassLayout(layout: TankLayout): YouSpotLayout {
	const glass = glassSpots(layout);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => {
			const at = glass.slots[index] ?? glass.you;
			// A notice floats in the queue (a note in a bottle), low enough that
			// its taller post puts its plate in line with the creatures' plates.
			return [slot, [at[0], at[1] - NOTICE_DROP, at[2]] as Vec3];
		})
	) as Record<YouSlot, Vec3>;
	const above: Vec3 = [glass.you[0], glass.you[1] + 0.9, glass.you[2]];
	return {
		offStage: above,
		slots,
		tally: above,
		timer: [0.45, 0, -0.15],
		tray: glass.tray,
		trayStep: [-0.6, 0, 0],
	};
}

/**
 * The act props: on the sand under each creature's home the kit's
 * ActStation (pearls, castle sign, red pearls, the clam's clock, unread
 * shells, suggestion notes), and at the front glass the kit's YouSpots
 * (notices, sand timers, the shell chest, the tallies). Pointer targets
 * only (`focusable={false}`): the list and the queue carry the keyboard.
 */
export function AquariumActProps({
	acts,
	handlers,
	layout,
	offStage,
	onStage,
	owners,
	palette,
	slots,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: AquariumActHandlers;
	layout: TankLayout;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	palette: {
		bubble: string;
		coral: string;
		pearl: string;
		sand: string;
		shell: string;
	};
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}) {
	const sand = TANK_FLOOR + 0.02;
	return (
		<group>
			{[...layout.swims].map(([id, swim]) => {
				const act = acts.get(id);
				if (!act) {
					return null;
				}
				const [x, , z] = swim.home;
				return (
					<group key={id}>
						{act.act === "working" && !act.stalled && reefKind(act) ? (
							<ReefFeature
								at={[x + REEF_OUT[0], sand, z + REEF_OUT[2]]}
								kind={reefKind(act) ?? "coral"}
								palette={palette}
							/>
						) : null}
						<ActStation
							act={act}
							at={[x, sand, z]}
							clock={handlers.clock}
							focusable={false}
							iconOnly={handlers.iconOnly}
							layout={handlers.iconOnly ? PHONE_SAND_LAYOUT : SAND_LAYOUT}
							limitText={aquariumLimitText}
							nowMs={handlers.nowMs}
							onAsk={handlers.onAsk}
							onBlocker={handlers.onBlocker}
							pipSkin={{ done: palette.pearl, todo: palette.sand }}
							privacy={handlers.privacy}
							reduced={handlers.reduced}
							shown={handlers.shown}
							snapshot={handlers.snapshot}
						/>
					</group>
				);
			})}
			<YouSpots
				focusable={false}
				iconOnly={handlers.iconOnly}
				item={AQUARIUM_SKIN.deliverable}
				layout={glassLayout(layout)}
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
				timerSkin={{ color: palette.sand }}
			/>
		</group>
	);
}
