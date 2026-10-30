/* eslint-disable react/no-unknown-property */
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import { LIFE_FACE_CAMERA } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { PipSkin } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import {
	besideStation,
	floorPoint,
	QUIZ_ACT_SKIN,
	QUIZ_CHAIR,
	type QuizActView,
} from "./quiz-acts-set.ts";
import { QUIZ_3D } from "./quiz-palette.ts";

/**
 * "Sitting out, back 15:10": the quiz show's words for a usage limit (lower
 * case after the kit's "Likely " when the limit is only estimated).
 */
export const quizLimitText: LimitText = (act, at) => {
	const words = at ? `sitting out, back ${at}` : "sitting out";
	return limitIsLikely(act) ? words : `S${words.slice(1)}`;
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
