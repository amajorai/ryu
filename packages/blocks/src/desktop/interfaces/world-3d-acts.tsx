/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
	WorldEntity,
	WorldLayout,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, useMemo } from "react";
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
	askItem,
	type OffStage,
	slotOf,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { alarmTone } from "./game3d-alarm.tsx";
import type { FollowBody } from "./game3d-anchor.tsx";
import { ApprenticeTally, apprenticeSpecs } from "./game3d-apprentice.tsx";
import type { LifeItem } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { type MemberLooks, Villagers } from "./game3d-villager.tsx";
import { WORLD_3D_ACT } from "./world-3d-palette.ts";
import { tileToWorld } from "./world-3d-theme.ts";

/**
 * The world's act layer in the canvas. An asking agent walks to your
 * doorstep (the spawn) and queues there beside a lantern that dims the
 * longer you leave it; answers are set down in the basket on your step.
 * At each agent's own door: a red lantern per counted failure, a grey flag
 * for an interrupted run, a porch clock while it waits out a limit, and
 * the kit's station (alarms with the reason, limit words, pips, the next
 * sign, the unread mark, the suggestion note, its board). Nothing in the
 * canvas takes focus: the per-agent targets are the DOM lists (spec 5.1).
 */

/** How dim an asking lantern gets: fully lit when new, dim after an hour. */
export function lanternGlow(sinceMs: number | null, nowMs: number): number {
	if (sinceMs === null) {
		return 1;
	}
	const minutes = Math.max(0, nowMs - sinceMs) / 60_000;
	return Math.max(0.35, 1 - minutes / 90);
}

/** Where a door's props sit: between the agent and its door, and above. */
export function doorPoint(layout: WorldLayout, entity: WorldEntity): Vec3 {
	const step = tileToWorld(layout, entity);
	const door = tileToWorld(layout, { x: entity.x, y: entity.y - 1 });
	return [(step[0] + door[0]) / 2, 0, (step[2] + door[2]) / 2];
}

function Lantern({
	at,
	color,
	glow,
}: {
	at: Vec3;
	color: string;
	glow: number;
}) {
	return (
		<group position={[at[0] + 0.45, 1.25 + at[1], at[2]]}>
			{/* Caps above and below the glass, so the light shows on every side. */}
			{[0.13, -0.13].map((y) => (
				<mesh key={y} position={[0, y, 0]}>
					<boxGeometry args={[0.24, 0.05, 0.24]} />
					<meshBasicMaterial color={WORLD_3D_ACT.lanternFrame} />
				</mesh>
			))}
			<mesh>
				<boxGeometry args={[0.18, 0.21, 0.18]} />
				<meshBasicMaterial
					color={glow > 0.5 ? color : WORLD_3D_ACT.lanternDim}
					opacity={0.5 + glow * 0.5}
					toneMapped={false}
					transparent
				/>
			</mesh>
		</group>
	);
}

function Flag({ at }: { at: Vec3 }) {
	return (
		<group position={[at[0] + 0.5, 0, at[2] + 0.1]}>
			<mesh position={[0, 0.6, 0]}>
				<cylinderGeometry args={[0.025, 0.025, 1.2, 6]} />
				<meshBasicMaterial color={WORLD_3D_ACT.flagPole} />
			</mesh>
			<mesh position={[0.16, 1.05, 0]}>
				<boxGeometry args={[0.3, 0.2, 0.02]} />
				<meshBasicMaterial color={WORLD_3D_ACT.flag} />
			</mesh>
		</group>
	);
}

function PorchClock({ at }: { at: Vec3 }) {
	return (
		<group position={[at[0] - 0.45, 0.9, at[2]]} rotation={[Math.PI / 2, 0, 0]}>
			<mesh>
				<cylinderGeometry args={[0.2, 0.2, 0.05, 20]} />
				<meshBasicMaterial color={WORLD_3D_ACT.clockRim} />
			</mesh>
			<mesh position={[0, 0.03, 0]}>
				<cylinderGeometry args={[0.16, 0.16, 0.02, 20]} />
				<meshBasicMaterial color={WORLD_3D_ACT.clockFace} />
			</mesh>
		</group>
	);
}

/** The answer basket on your step, and the letter or scroll an ask carries. */
export const WORLD_ACT_SKIN: ActSkin = {
	deliverable: {
		accent: WORLD_3D_ACT.basketRim,
		color: WORLD_3D_ACT.basket,
		shape: "basket",
	},
};

/** What a villager carries for its act: its ask, or its answer on the way. */
export function worldCarry(act: InterfaceAgentAct): LifeItem | null {
	if (act.act === "asking") {
		return askItem(act, WORLD_ACT_SKIN);
	}
	return act.act === "delivering" ? WORLD_ACT_SKIN.deliverable : null;
}

/** "Back 15:10": a limit on the porch clock (the kit adds "Likely"). */
export const worldLimitText: LimitText = (_act, at) =>
	at ? `Back ${at}` : "Resting";

/**
 * Where a door's pieces sit round its agent (the doorstep is a tile in
 * front of the cottage): alarms up the door's right, limit and next sign
 * on its left, pips and the board in front of the step.
 */
export const WORLD_STATION_LAYOUT: Partial<StationLayout> = {
	alarms: [0.9, 0.4, -0.6],
	board: [0, 0, 1.2],
	limit: [-0.95, 0.3, -0.4],
	next: [-0.95, 0, -0.9],
	pips: [0, 0.05, 0.8],
	suggestion: [-0.8, 0, 0.9],
	unread: [0.95, 0, 0.6],
};

/**
 * Your doorstep at the spawn: four queue places in a row behind you, the
 * basket on your left, the "+N more" past the last place, and the
 * off-stage tally further back.
 */
export function worldYouSpot(layout: WorldLayout): {
	layout: YouSpotLayout;
	points: Record<string, Vec3>;
} {
	const you = tileToWorld(layout, layout.spawn);
	const at = (dx: number, dz: number, y = 0): Vec3 => [
		you[0] + dx,
		y,
		you[2] + dz,
	];
	// A row up the screen from you (toward the cottages, the way the
	// camera looks), either side of the path, so the queue is in frame;
	// the basket on your left.
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, at(-2.4 + index * 1.6, -1.3)])
	) as Record<YouSlot, Vec3>;
	const tray = at(-3.4, 0.2);
	return {
		layout: {
			offStage: at(0, -3, 1),
			slots,
			tally: at(3.6, -1.3, 0.6),
			timer: [0.55, 0, 0.35],
			tray,
		},
		// Askers past the four places wait by the tally, never on you.
		points: { ...slots, you: at(3.6, -2.3), "you-tray": tray },
	};
}

/**
 * Where a villager stands for its act: home, a place in the queue, or by
 * the basket (each deliverer `trayIndex` places along, never on another).
 */
export function worldActorAt(
	act: InterfaceAgentAct,
	home: Vec3,
	you: Record<string, Vec3>,
	slots: readonly YouSpotSlot[],
	still: boolean,
	trayIndex = 0
): Vec3 {
	const station = `home:${act.agentId}`;
	const target = actorTarget(
		act,
		{
			paths: { links: [], points: { ...you, [station]: home } },
			slot: slotOf(slots, act.agentId),
			station,
		},
		still
	).position;
	const along = act.act === "delivering" && !still ? Math.max(0, trayIndex) : 0;
	return [target[0] - along * 0.8, home[1], target[2] + along * 0.5];
}

/** What the act stage needs from the DOM side. */
export interface WorldActView {
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
	privacy: "full" | "redacted";
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	/** In a dialogue: the station plates stand down under the Choices panel. */
	talking?: boolean;
}

/** A lantern beside each queued agent, dimming with its wait. */
function QueueLanterns({
	points,
	view,
}: {
	points: Record<string, Vec3>;
	view: WorldActView;
}) {
	return (
		<group>
			{view.slots.slots.map((slot) => {
				const at = points[slot.point];
				if (!at) {
					return null;
				}
				return (
					<Lantern
						at={[at[0] - 0.9, 0, at[2] - 0.3]}
						color={WORLD_3D_ACT.lanternAsk}
						glow={lanternGlow(
							slot.ask.since ? Date.parse(slot.ask.since) : null,
							view.nowMs
						)}
						key={slot.point}
					/>
				);
			})}
		</group>
	);
}

/** The world's act stage: your doorstep, and every agent's door. */
export function WorldActStage({
	layout,
	reduced,
	sight = (_at, _index, station) => station,
	view,
}: {
	layout: WorldLayout;
	reduced: boolean;
	/** Wraps each station's plates: drawn only while they can be read there. */
	sight?: (at: Vec3, index: number, station: ReactNode) => ReactNode;
	view: WorldActView;
}) {
	const you = worldYouSpot(layout);
	const byId = new Map(
		layout.entities.map((entity) => [entity.agentId, entity])
	);
	return (
		<group>
			{view.talking ? null : (
				<YouSpots
					focusable={false}
					iconOnly={view.iconOnly}
					item={WORLD_ACT_SKIN.deliverable}
					layout={you.layout}
					nowMs={view.nowMs}
					offStage={view.offStage}
					onAsk={view.onAsk}
					onOpenQueue={view.onQueue}
					onStage={view.onStage}
					owners={view.owners}
					privacy={view.privacy}
					reduced={reduced}
					shown={view.shown}
					slots={view.slots}
					snapshot={view.snapshot}
					timerSkin={{ color: WORLD_3D_ACT.lanternAsk }}
				/>
			)}
			<QueueLanterns points={you.points} view={view} />
			{view.onStage.map((act, index) => {
				const entity = byId.get(act.agentId);
				if (!entity) {
					return null;
				}
				const door = doorPoint(layout, entity);
				// A lantern per failure the kit lights red (or calendar, for a
				// routine); a limit has its porch clock, an interrupt its flag.
				const failures = act.blockers.filter((blocker) => {
					const tone = alarmTone(blocker);
					return tone === "red" || tone === "calendar";
				});
				return (
					<group key={act.agentId}>
						{/* One red lantern per counted failure, a grey flag when
						    the run was only interrupted. */}
						{failures.map((blocker, index) => (
							<Lantern
								at={[door[0], index * 0.42, door[2]]}
								color={
									alarmTone(blocker) === "calendar"
										? WORLD_3D_ACT.lanternCalendar
										: WORLD_3D_ACT.lanternStop
								}
								glow={1}
								key={`${blocker.kind}:${blocker.title}:${index}`}
							/>
						))}
						{failures.length === 0 &&
						act.blockers.some((blocker) => alarmTone(blocker) === "grey") ? (
							<Flag at={door} />
						) : null}
						{act.act === "limited" ? <PorchClock at={door} /> : null}
						{/* Its plates stand down in a dialogue, under the Choices. */}
						{view.talking
							? null
							: sight(
									tileToWorld(layout, entity),
									index,
									<ActStation
										act={act}
										at={tileToWorld(layout, entity)}
										clock={view.clock}
										focusable={false}
										iconOnly={view.iconOnly}
										layout={WORLD_STATION_LAYOUT}
										limitText={worldLimitText}
										nowMs={view.nowMs}
										onAsk={view.onAsk}
										onBlocker={view.onBlocker}
										privacy={view.privacy}
										reduced={reduced}
										shown={view.shown}
										snapshot={view.snapshot}
									/>
								)}
					</group>
				);
			})}
		</group>
	);
}

/**
 * Each agent's running helpers (kit Apprentices): small villagers around
 * the agent's walking body, with the "+N" and "×" words on the curved
 * ground. Rebuilt only when a helper count changes, not on every tick.
 */
export function WorldHelpers({
	acts,
	follow,
	ground,
	hidden,
	looks,
	reduced,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** The agent's walking body. */
	follow: (agentId: string) => FollowBody;
	/** The ground height the helpers stand on. */
	ground: number;
	/** A conversation has the frame: the helpers step out of it. */
	hidden: boolean;
	looks: ReadonlyMap<string, MemberLooks>;
	reduced: boolean;
}) {
	const key = [...acts.values()]
		.flatMap((act) =>
			act.helpers && looks.has(act.agentId)
				? [`${act.agentId}:${act.helpers.running}:${act.helpers.failed}`]
				: []
		)
		.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the helper counts.
	const helpers = useMemo(
		() =>
			[...acts.values()].flatMap((act) => {
				const agentLooks = looks.get(act.agentId);
				return act.helpers && agentLooks
					? [{ agentId: act.agentId, helpers: act.helpers, looks: agentLooks }]
					: [];
			}),
		[key, looks]
	);
	const specs = useMemo(
		() =>
			helpers.flatMap((entry) =>
				apprenticeSpecs({
					...entry,
					follow: follow(entry.agentId),
					station: [0, ground, 0],
				})
			),
		[follow, ground, helpers]
	);
	if (hidden || specs.length === 0) {
		return null;
	}
	return (
		<>
			<Villagers plates={false} reducedMotion={reduced} villagers={specs} />
			{helpers.map((entry) => (
				<ApprenticeTally
					follow={follow(entry.agentId)}
					helpers={entry.helpers}
					key={entry.agentId}
					station={[0, ground, 0]}
				/>
			))}
		</>
	);
}
