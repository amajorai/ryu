import type { InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { PlantedTree } from "./game3d-props.tsx";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import type { Contestant } from "./quiz-model.ts";
import { QUIZ_3D } from "./quiz-palette.ts";
import { STAGE_HEIGHT } from "./quiz-studio-cast.ts";
import { headerLines, panelCanvas } from "./quiz-studio-panel.tsx";
import {
	audienceSeats,
	FLOOR_RADIUS,
	podiumSpots,
	TOWARD,
	TRUSS_HEIGHT,
	WALL,
	wallPoint,
} from "./quiz-world.ts";

/**
 * With acts a podium's screen fills most of its front, so a six- or
 * seven-letter word ("Buzzed", "Working") still reads at desktop size.
 */
export const ACT_SCREEN = { height: 0.64, width: 1.28 };

/** The biggest size (up to 100 px) a podium word fits the screen at. */
function fitWordSize(words: string): number {
	if (typeof document === "undefined") {
		return 100;
	}
	const context = document.createElement("canvas").getContext("2d");
	if (!context) {
		return 100;
	}
	let size = 100;
	while (size > 40) {
		context.font = `900 ${size}px ui-rounded, system-ui, sans-serif`;
		if (context.measureText(words).width <= 236) {
			break;
		}
		size -= 4;
	}
	return size;
}

/**
 * A podium's lit screen: its contestant's messages, or with acts what the
 * contestant is on in one word ("X", "Out", "Editing").
 */
export function scoreCanvas(
	words: string,
	acted = false
): HTMLCanvasElement | null {
	const face = {
		bevel: QUIZ_3D.rim,
		foot: QUIZ_3D.screen,
		ink: QUIZ_3D.screenInk,
		top: QUIZ_3D.screen,
	};
	// An act's word is one short line in the biggest letters that fit.
	if (acted) {
		return panelCanvas(face, [words], fitWordSize(words), true);
	}
	const lines = /^\d+$/.test(words) ? [words] : headerLines(words);
	let size = 84;
	if (lines.length > 1) {
		size = 54;
	} else if (words.length > 4) {
		size = 64;
	}
	return panelCanvas(face, lines, size, true);
}

/** Podiums: chunky bodies, desks and the lamp lit while an agent works. */
export function podiumParts(
	contestants: readonly Contestant[],
	/** With acts the lamp is unlit: the progress pips light the podium. */
	acted = false
) {
	const bodies: InstanceSpec[] = [];
	const desks: InstanceSpec[] = [];
	const lamps: InstanceSpec[] = [];
	for (const [index, [x, z]] of podiumSpots().entries()) {
		const contestant = contestants[index];
		const box = (y: number, out: number, size: Vec3, color?: string) => ({
			color,
			position: [
				x + TOWARD[0] * out,
				STAGE_HEIGHT + y,
				z + TOWARD[1] * out,
			] as Vec3,
			rotation: [0, FACE_CAMERA, 0] as Vec3,
			scale: size,
		});
		bodies.push(box(0.42, 0, [1.4, 0.84, 0.78], QUIZ_3D.podium));
		desks.push(box(0.88, -0.04, [1.56, 0.1, 0.94], QUIZ_3D.podiumDesk));
		lamps.push(
			box(
				0.12,
				0.4,
				[1.1, 0.07, 0.02],
				contestant?.working && !acted ? QUIZ_3D.lampOn : QUIZ_3D.lampOff
			)
		);
	}
	return { bodies, desks, lamps };
}

/** The truss over the board, its lamps, their beams and the pools they light. */
export function rigParts() {
	const truss: InstanceSpec[] = [];
	const lamps: InstanceSpec[] = [];
	const beams: InstanceSpec[] = [];
	const pools: InstanceSpec[] = [];
	// The lamps hang off the backdrop's top edge, over the board.
	const y = TRUSS_HEIGHT;
	for (const along of [-3, -0.9, 1.4, 3.6]) {
		const at = wallPoint(along + 0.9, 0.45, y + 0.2);
		lamps.push({ color: QUIZ_3D.lamp, position: at, scale: [0.22, 0.4, 0.22] });
		truss.push({
			color: QUIZ_3D.truss,
			position: [at[0], at[1] + 0.32, at[2]],
			scale: [0.05, 0.4, 0.05],
		});
		const target = wallPoint(along + 0.9, 4.4, 0);
		const ux = at[0] - target[0];
		const uz = at[2] - target[2];
		const length = Math.hypot(ux, at[1], uz);
		beams.push({
			color: QUIZ_3D.beam,
			position: [(at[0] + target[0]) / 2, at[1] / 2, (at[2] + target[2]) / 2],
			rotation: [
				Math.atan2(uz / length, at[1] / length),
				0,
				-Math.asin(ux / length),
			],
			scale: [1, length, 1],
		});
		pools.push({
			color: QUIZ_3D.pool,
			position: [target[0], STAGE_HEIGHT + 0.012, target[2]],
			rotation: [-Math.PI / 2, 0, 0],
			scale: 0.95,
		});
	}
	return { beams, lamps, pools, truss };
}

/** Marquee bulbs along the top of the curved backdrop. */
export function marqueeBulbs(radius: number, height: number): InstanceSpec[] {
	const bulbs: InstanceSpec[] = [];
	const [cx, , cz] = wallPoint(0, 2, 0);
	for (let index = 0; index <= 28; index++) {
		const angle = FACE_CAMERA + Math.PI - 1.15 + (index / 28) * 2.3;
		bulbs.push({
			color: QUIZ_3D.bulb,
			position: [
				cx + Math.sin(angle) * (radius - 0.08),
				height + 0.1,
				cz + Math.cos(angle) * (radius - 0.08),
			],
			scale: 0.07,
		});
	}
	return bulbs;
}

/** Theatre seats: a velvet seat and back in a dark frame. */
export function seatParts() {
	const frames: InstanceSpec[] = [];
	const velvet: InstanceSpec[] = [];
	const away: [number, number] = [-TOWARD[0], -TOWARD[1]];
	for (const seat of audienceSeats()) {
		const [x, z] = seat.at;
		const y = seat.row * 0.25;
		const turn: Vec3 = [0, FACE_CAMERA, 0];
		frames.push({
			position: [x, y + 0.14, z],
			rotation: turn,
			scale: [0.78, 0.28, 0.66],
		});
		velvet.push(
			{ position: [x, y + 0.34, z], rotation: turn, scale: [0.66, 0.12, 0.56] },
			{
				position: [x - away[0] * 0.3, y + 0.62, z - away[1] * 0.3],
				rotation: turn,
				scale: [0.68, 0.6, 0.12],
			}
		);
		if (seat.row > 0) {
			// The back row sits on a riser.
			frames.push({
				position: [x, y / 2, z],
				rotation: turn,
				scale: [1.05, y, 1],
			});
		}
	}
	return { frames, velvet };
}

/** Trees round the island beyond the set. */
export function rimTrees(shape: IslandShape): PlantedTree[] {
	const trees: PlantedTree[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const [cx, , cz] = wallPoint(0.9, 3.6, 0);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const out =
				(fx - WALL.centre[0]) * TOWARD[0] + (fz - WALL.centre[1]) * TOWARD[1];
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				Math.hypot(fx - cx, fz - cz) < FLOOR_RADIUS + 0.4 ||
				out > 4 ||
				hash > 0.6
			) {
				continue;
			}
			trees.push({
				at: [fx, 0, fz],
				kind: hash < 0.3 ? "cedar" : "fruit",
				scale: 0.75 + jitter(x, y, 9) * 0.35,
				seed: Math.round(hash * 1000),
			});
		}
	}
	return trees;
}
