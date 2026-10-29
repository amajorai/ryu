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
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
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
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { PipSkin } from "./game3d-meters.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import { QUIZ_3D } from "./quiz-palette.ts";
import { wallPoint } from "./quiz-world.ts";

/**
 * The quiz show's act layer: contestants work at their podiums (scribbling
 * their answers, the podium's screen saying what they are on and its
 * lights counting progress), buzz in and walk to the host's lectern to ask
 * (you are the host; a shot clock counts their wait, and notices for
 * parked and unowned asks pin to posts there), set an answer down on the
 * lectern's tray, sit out a usage limit on a chair beside the stage, and
 * light a red X on their podium when a run stops. Words only come from
 * the act (`agentActs` on an already-redacted snapshot).
 */

/** What the quiz scene needs to act out the snapshot. */
export interface QuizActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/** Narrow stages: act props and plates collapse to glyphs. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	/** Owner names of asks, for notice plates ("Ada asks: …"). */
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	/** The overlay budget's chosen ids (actOverlays). */
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
}

/** The podiums' line out from the wall (quiz-world.ts PODIUM_OUT). */
const PODIUM_LINE = 4.4;
/**
 * Where the queue stands (along the wall, out past the podium line): two
 * rows of two left of the host's lectern, on the island, so no queue plate
 * covers the host or a podium screen; the back row a plate height and more
 * nearer the camera, straight behind the front one.
 */
const QUEUE_SPOTS: readonly (readonly [number, number])[] = [
	[-6.5, 0.3],
	[-8.7, 0.3],
	[-6.5, 2.6],
	[-8.7, 2.6],
];

/** The sitting-out chair: behind the podium's left, off its screen. */
const QUIZ_CHAIR = { across: -1.1, out: -0.3 };

/** The quiz show's produce: a clue card with the answer. */
export const QUIZ_ACT_SKIN: ActSkin = {
	// A contestant buzzing in carries the clue card to the lectern.
	askItem: { color: QUIZ_3D.clueCard, shape: "letter" },
	deliverable: { shape: "box" },
};

/** The stage's height and footprint (an ellipse round the podiums). */
const STAGE = { along: 0.9, height: 0.2, out: 4.1, radius: 3.4, stretch: 1.7 };

/** A point on the set: `along` the wall, `out` toward the camera, on the stage or the floor. */
function setPoint(along: number, out: number): Vec3 {
	const onStage =
		((along - STAGE.along) / (STAGE.radius * STAGE.stretch)) ** 2 +
			((out - STAGE.out) / STAGE.radius) ** 2 <=
		1;
	return wallPoint(along, out, onStage ? STAGE.height : 0);
}

/** A floor offset `across` the view and `out` toward the camera. */
function floorPoint(across: number, out: number, y: number): Vec3 {
	const c = Math.SQRT1_2;
	return [across * c + out * c, y, -across * c + out * c];
}

/** The host's lectern, in wall coordinates (quiz-world.ts `hostSpot`). */
const LECTERN = { along: -4.7, out: 4.2 };

/**
 * The queue at the host's lectern: on wide stages four slots in two rows
 * left of the lectern (clear of the host, the podium screens and the
 * audience); on a phone one diagonal from the lectern, left of the
 * podiums. The tray stands on the lectern's left; the off-stage tally
 * beyond the podiums' right end.
 */
export function quizYouSpot(narrow: boolean): {
	layout: YouSpotLayout;
	points: Record<string, Vec3>;
} {
	const slot = (index: number): Vec3 =>
		narrow
			? setPoint(
					LECTERN.along + 0.4 + index * 1.5,
					LECTERN.out + 2 + index * 1.9
				)
			: // Left of the podiums: clear of their screens, the audience and
				// the contestants' plates and alarms.
				setPoint(
					QUEUE_SPOTS[index]?.[0] ?? 0,
					PODIUM_LINE + (QUEUE_SPOTS[index]?.[1] ?? 0)
				);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	const tray = setPoint(LECTERN.along - 1.3, LECTERN.out + 0.2);
	const last = slot(3);
	return {
		layout: {
			offStage: wallPoint(narrow ? 6.6 : 8.4, 4.8, 0.6),
			slots,
			tally: [last[0] + 1.1, last[1] + 0.6, last[2] - 0.6],
			timer: [0.45, 0, 0.2],
			tray,
			trayStep: [-0.42, 0, 0.42],
		},
		points: {
			...slots,
			you: setPoint(LECTERN.along + 0.9, LECTERN.out + 1.2),
			"you-tray": tray,
		},
	};
}

/**
 * Waypoints: each contestant's place behind its podium, the gap beside
 * the podium, the front of the stage below it, joined along the front to
 * the lectern.
 */
export function quizPaths(
	stations: ReadonlyMap<string, Vec3>,
	you: Record<string, Vec3>
): LifePaths {
	const points: Record<string, Vec3> = { ...you };
	const links: [string, string][] = [
		["you", "you-1"],
		["you", "you-2"],
		["you-1", "you-3"],
		["you-2", "you-4"],
		["you-1", "you-2"],
		["you-3", "you-4"],
		["you", "you-tray"],
	];
	for (const [id, at] of stations) {
		const side = `side:${id}`;
		const front = `front:${id}`;
		points[`station:${id}`] = at;
		points[side] = besideStation(at, 1.15, 0.2);
		points[front] = besideStation(at, 1.15, 1.9);
		points[`chair:${id}`] = besideStation(
			at,
			QUIZ_CHAIR.across,
			QUIZ_CHAIR.out
		);
		links.push(
			[`station:${id}`, side],
			[side, front],
			[front, "you"],
			[front, `chair:${id}`]
		);
	}
	return { links, points };
}

/** A point beside a station: `across` and `out` from it. */
export function besideStation(
	station: Vec3,
	across: number,
	out: number
): Vec3 {
	const offset = floorPoint(across, out, 0);
	return [station[0] + offset[0], station[1], station[2] + offset[2]];
}

/**
 * A contestant's villager for its act: its life script, its plate named
 * by the act sentence (an asking contestant's plate is its queue plate,
 * "Ada · 14m", and answers the ask), its tool while working.
 */
export function quizContestant({
	act,
	base,
	label,
	looks,
	paths,
	reduced,
	view,
}: {
	act: InterfaceAgentAct;
	base: Pick<VillagerSpec, "facing" | "id" | "position">;
	/** The game's own action suffix for other acts ("Ask the final question."). */
	label: string;
	looks: MemberLooks;
	paths: LifePaths;
	reduced: boolean;
	view: QuizActView;
}): VillagerSpec[] {
	const spots: ActSpots = {
		paths,
		// A limited contestant sits out on the chair beside its podium.
		rest: `chair:${act.agentId}`,
		slot: slotOf(view.slots.slots, act.agentId),
		station: `station:${act.agentId}`,
		stationFacing: base.facing ?? LIFE_FACE_CAMERA,
	};
	const ask = act.act === "asking" ? act.ask : null;
	const queued = ask !== null && spots.slot !== null;
	const bubbleId = bubbleOverlayId(act);
	const player: VillagerSpec = {
		...base,
		activate: ask ? () => view.onAsk(ask.id) : undefined,
		actAgent: act.agentId,
		bubble: bubbleId ? view.shown.has(bubbleId) : true,
		// The back row's bubbles hang left, toward open ground: hung right
		// they reach the host's lectern.
		bubbleSide:
			queued && (spots.slot === "you-3" || spots.slot === "you-4")
				? "left"
				: undefined,
		iconOnly: queued ? false : undefined,
		label: ask
			? `${act.ariaLabel} Answer their ask.`
			: `${act.ariaLabel} ${label}`,
		life: actLife(act, spots, QUIZ_ACT_SKIN, { reduced }),
		looks: {
			...looks,
			tool:
				act.act === "working"
					? toolForActivity(act.carry, QUIZ_TOOLS)
					: undefined,
		},
		name: ask
			? queuePlateText(
					act.agentName,
					{
						approx: ask.sinceApprox,
						since: ask.since,
						until: ask.expiresAt ?? null,
						untilApprox: ask.expiresApprox,
					},
					view.nowMs
				)
			: act.agentName,
		pose: "idle",
		youSpot: queued ? "slot" : undefined,
	};
	const station = base.position;
	return [
		player,
		...apprenticeSpecs({
			agentId: act.agentId,
			helpers: act.helpers,
			looks,
			// Behind the contestant's left: the podium lights stay in view.
			station: besideStation(station, -0.9, -0.3),
		}),
	];
}

/** Podium screen words stay this short: one line, big enough to read. */
export const PODIUM_WORD_MAX = 8;

/**
 * What a podium's screen says for its contestant's act, in one short word
 * (the reasons ride the alarm plates beside it): the step's verb while
 * working, a buzzer's X for a stopped run, or the show's words.
 */
export function podiumWords(act: InterfaceAgentAct): string {
	const focus = act.blockers[0];
	switch (act.act) {
		case "asking":
			return "Buzzed";
		case "blocked":
			return focus?.kind === "interrupted" ? "Paused" : "X";
		case "delivering":
			return "Answer";
		case "limited":
			return "Out";
		case "working": {
			const verb = act.bubble?.text?.split(/\s+/)[0] ?? "";
			return verb && verb.length <= PODIUM_WORD_MAX ? verb : "Working";
		}
		default: {
			const letters = Array.from(act.agentName);
			return letters.length > PODIUM_WORD_MAX
				? `${letters.slice(0, PODIUM_WORD_MAX - 1).join("")}…`
				: act.agentName;
		}
	}
}

/**
 * "Sitting out, back 15:10": the quiz show's words for a usage limit (lower
 * case after the kit's "Likely " when the limit is only estimated).
 */
export const quizLimitText: LimitText = (act, at) => {
	const words = at ? `sitting out, back ${at}` : "sitting out";
	return limitIsLikely(act) ? words : `S${words.slice(1)}`;
};

/** A contestant scribbles its answers with a quill, whatever it does. */
const QUIZ_TOOLS: Partial<Record<InterfaceActivityKind, VillagerTool>> = {
	answer: "quill",
	edit: "quill",
	plan: "quill",
	think: "quill",
	write: "quill",
};

/** The podium lights: progress pips in the show's lamp colours. */
const QUIZ_PIPS: PipSkin = {
	done: QUIZ_3D.pipDone,
	estimate: QUIZ_3D.pipEstimate,
	todo: QUIZ_3D.pipTodo,
};

/**
 * Where a podium's pieces sit round its contestant (who stands behind the
 * podium): the lights on the desk, the station board's words in the gap
 * at the podium's left (off the screens and the audience), the alarms
 * under its screen, the marks at its right, the next sign behind it, the
 * limit cue by its podium.
 */
export const QUIZ_STATION_LAYOUT: Partial<StationLayout> = {
	// Centred under the podium's own screen, dropping a row per alarm
	// toward the audience: a neighbour on either side, so hanging left or
	// right covers one; here they pass between the neighbours' screens.
	alarmRows: -1,
	alarmSide: "center",
	alarms: floorPoint(0, 1.2, -1.6),
	// In the gap left of the podium at desk height: its short lines between
	// the figures, the last over the desk tops, so it covers neither podium
	// screen nor the audience below them.
	board: floorPoint(-1.4, 0.6, 1.6),
	cue: [0, 0.02, 0],
	limit: floorPoint(-0.9, 0.9, 0.2),
	next: floorPoint(-0.5, -0.6, 0),
	// On the desk top, in front of the contestant's hands: seen from above.
	pips: floorPoint(0, 0.85, 0.98),
	suggestion: floorPoint(0.95, 1.7, 0),
	unread: floorPoint(1, -0.3, 0),
};

/**
 * A contestant sitting out: it rests on the chair in the gap at its
 * podium's left, where the board would stand, so its board ("Sitting out,
 * back 15:10") hangs under its own empty podium's screen instead.
 */
export const QUIZ_STATION_LAYOUT_SITTING_OUT: Partial<StationLayout> = {
	...QUIZ_STATION_LAYOUT,
	// A row lower, so a limit blocker's own alarm hangs under the board.
	alarms: floorPoint(0, 1.2, -2.35),
	board: floorPoint(0, 1.2, -0.45),
};

function lift(at: Vec3, by: number): Vec3 {
	return [at[0], at[1] + by, at[2]];
}

/** A stopped run's buzzer: a red X lit on the podium's front, by its screen. */
function Buzzer({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, LIFE_FACE_CAMERA, 0]}>
			{[Math.PI / 4, -Math.PI / 4].map((turn) => (
				<mesh key={turn} rotation={[0, 0, turn]}>
					<boxGeometry args={[0.24, 0.06, 0.03]} />
					<meshBasicMaterial color={QUIZ_3D.buzzerX} toneMapped={false} />
				</mesh>
			))}
		</group>
	);
}

/** The sitting-out chair a limited contestant rests on. */
function Chair({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, LIFE_FACE_CAMERA, 0]}>
			<ToonMesh color={QUIZ_3D.chairSeat} position={[0, 0.32, 0]}>
				<boxGeometry args={[0.46, 0.08, 0.42]} />
			</ToonMesh>
			<ToonMesh color={QUIZ_3D.chairSeat} position={[0, 0.6, -0.19]}>
				<boxGeometry args={[0.46, 0.5, 0.06]} />
			</ToonMesh>
			{[-0.19, 0.19].map((x) => (
				<ToonMesh color={QUIZ_3D.chairFrame} key={x} position={[x, 0.16, 0]}>
					<boxGeometry args={[0.05, 0.32, 0.4]} />
				</ToonMesh>
			))}
		</group>
	);
}

/**
 * Everything the act layer draws besides the contestants: the kit's
 * you-spot at the lectern (notices, shot clocks beside queued contestants,
 * the tallies, the answer tray), and each podium's station, its buzzer and
 * its sitting-out chair.
 */
export function QuizActProps({
	onStage,
	reduced,
	stations,
	view,
	youLayout,
}: {
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	stations: ReadonlyMap<string, Vec3>;
	view: QuizActView;
	youLayout: YouSpotLayout;
}) {
	return (
		<group>
			<YouSpots
				iconOnly={view.iconOnly}
				item={QUIZ_ACT_SKIN.deliverable}
				layout={youLayout}
				nowMs={view.nowMs}
				offStage={view.offStage}
				onAsk={view.onAsk}
				onOpenQueue={view.onQueue}
				onStage={onStage}
				owners={view.owners}
				privacy={view.privacy}
				reduced={reduced}
				shown={view.shown}
				slots={view.slots}
				snapshot={view.snapshot}
				timerSkin={{ color: QUIZ_3D.shotClock }}
			/>
			{onStage.map((act) => {
				const station = stations.get(act.agentId);
				if (!station) {
					return null;
				}
				const focus = act.blockers[0];
				return (
					<group key={act.agentId}>
						{act.act === "blocked" && focus && focus.kind !== "interrupted" ? (
							<Buzzer at={lift(besideStation(station, -0.74, 1.22), 0.5)} />
						) : null}
						{act.act === "limited" ? (
							<Chair
								at={besideStation(station, QUIZ_CHAIR.across, QUIZ_CHAIR.out)}
							/>
						) : null}
						<ActStation
							act={act}
							at={station}
							clock={view.clock}
							iconOnly={view.iconOnly}
							layout={
								act.act === "limited"
									? QUIZ_STATION_LAYOUT_SITTING_OUT
									: QUIZ_STATION_LAYOUT
							}
							limitText={quizLimitText}
							nowMs={view.nowMs}
							onAsk={view.onAsk}
							onBlocker={view.onBlocker}
							pipSkin={QUIZ_PIPS}
							privacy={view.privacy}
							reduced={reduced}
							shown={view.shown}
							snapshot={view.snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
