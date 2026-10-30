import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ActSkin, OffStage, YouSpotSlot } from "./game3d-acts.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { QUIZ_3D } from "./quiz-palette.ts";
import { wallPoint } from "./quiz-world.ts";

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
export const PODIUM_LINE = 4.4;
/**
 * Where the queue stands (along the wall, out past the podium line): two
 * rows of two left of the host's lectern, on the island, so no queue plate
 * covers the host or a podium screen; the back row a plate height and more
 * nearer the camera, straight behind the front one.
 */
export const QUEUE_SPOTS: readonly (readonly [number, number])[] = [
	[-6.5, 0.3],
	[-8.7, 0.3],
	[-6.5, 2.6],
	[-8.7, 2.6],
];

/** The sitting-out chair: behind the podium's left, off its screen. */
export const QUIZ_CHAIR = { across: -1.1, out: -0.3 };

/** The quiz show's produce: a clue card with the answer. */
export const QUIZ_ACT_SKIN: ActSkin = {
	// A contestant buzzing in carries the clue card to the lectern.
	askItem: { color: QUIZ_3D.clueCard, shape: "letter" },
	deliverable: { shape: "box" },
};

/** The stage's height and footprint (an ellipse round the podiums). */
const STAGE = { along: 0.9, height: 0.2, out: 4.1, radius: 3.4, stretch: 1.7 };

/** A point on the set: `along` the wall, `out` toward the camera, on the stage or the floor. */
export function setPoint(along: number, out: number): Vec3 {
	const onStage =
		((along - STAGE.along) / (STAGE.radius * STAGE.stretch)) ** 2 +
			((out - STAGE.out) / STAGE.radius) ** 2 <=
		1;
	return wallPoint(along, out, onStage ? STAGE.height : 0);
}

/** A floor offset `across` the view and `out` toward the camera. */
export function floorPoint(across: number, out: number, y: number): Vec3 {
	const c = Math.SQRT1_2;
	return [across * c + out * c, y, -across * c + out * c];
}

/** The host's lectern, in wall coordinates (quiz-world.ts `hostSpot`). */
export const LECTERN = { along: -4.7, out: 4.2 };

/** A point beside a station: `across` and `out` from it. */
export function besideStation(
	station: Vec3,
	across: number,
	out: number
): Vec3 {
	const offset = floorPoint(across, out, 0);
	return [station[0] + offset[0], station[1], station[2] + offset[2]];
}
