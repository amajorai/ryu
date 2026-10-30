import type { FlowerPatch } from "./game3d-grass.tsx";
import type { InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { PlacedBush, PlacedProp, PlantedTree } from "./game3d-props.tsx";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import { LOBBY_3D } from "./lobby-palette.ts";
import {
	type LobbyWorld,
	PLAZA_RADIUS,
	RECENT_MATCHES,
} from "./lobby-world.ts";

/** The Lobby diorama's static set dressing: boards, scenery and furniture. */

/** Toward the camera on the ground, as a unit vector. */
export const TOWARD: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
/** Height of one recent match's row on the board. */
export const MATCH_ROW = 0.7;

/** A box part of a board standing at `at`, turned to face the camera. */
function boardBox(
	at: [number, number],
	local: Vec3,
	size: Vec3,
	color?: string
): InstanceSpec {
	// Local x runs along screen right; local z toward the camera.
	const across: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
	return {
		color,
		position: [
			at[0] + across[0] * local[0] + TOWARD[0] * local[2],
			local[1],
			at[1] + across[1] * local[0] + TOWARD[1] * local[2],
		],
		rotation: [0, FACE_CAMERA, 0],
		scale: size,
	};
}

/** The quest board and the matches board: posts, frames, cork and notes. */
export function boardParts(
	world: LobbyWorld,
	/** A phone with the act layer has no room for the matches board. */
	withMatches = true
) {
	const posts: InstanceSpec[] = [];
	const frames: InstanceSpec[] = [];
	const corks: InstanceSpec[] = [];
	const notes: InstanceSpec[] = [];
	const boards = [
		{ at: world.questBoard, height: 1.25, notes: 5, width: 2 },
		{
			at: world.matches.at,
			height: MATCH_ROW * RECENT_MATCHES + 0.5,
			notes: 0,
			width: 3,
		},
	].slice(0, withMatches ? 2 : 1);
	for (const [index, board] of boards.entries()) {
		const half = board.width / 2;
		const centre = 0.55 + board.height / 2;
		for (const side of [-1, 1]) {
			posts.push(
				boardBox(
					board.at,
					[side * (half - 0.08), (centre + board.height / 2 + 0.1) / 2, -0.04],
					[0.12, centre + board.height / 2 + 0.1, 0.12]
				)
			);
		}
		frames.push(
			boardBox(
				board.at,
				[0, centre, 0],
				[board.width, board.height + 0.14, 0.1],
				LOBBY_3D.boardFrame
			)
		);
		corks.push(
			boardBox(
				board.at,
				[0, centre, 0.03],
				[board.width - 0.2, board.height - 0.08, 0.08],
				LOBBY_3D.boardCork
			)
		);
		for (let note = 0; note < board.notes; note++) {
			const column = note % 3;
			const row = Math.floor(note / 3);
			notes.push(
				boardBox(
					board.at,
					[
						(column - 1) * 0.55 + (jitter(note, index, 3) - 0.5) * 0.12,
						centre + 0.25 - row * 0.5,
						0.08,
					],
					[0.42, 0.34, 0.02],
					LOBBY_3D.notes[note % LOBBY_3D.notes.length]
				)
			);
		}
	}
	return { corks, frames, notes, posts };
}

/** Trees round the island's rim, shrubs and flowers, clear of the plaza. */
export function scenery(world: LobbyWorld, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const clear = [world.questBoard, world.portal, world.matches.at];
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const radius = Math.hypot(fx, fz);
			if (!onIsland(shape, fx, fz, 0.6) || radius < PLAZA_RADIUS + 0.4) {
				continue;
			}
			if (clear.some(([cx, cz]) => Math.hypot(cx - fx, cz - fz) < 2)) {
				continue;
			}
			// Woods at the back; the front corner (toward the camera) stays lawn.
			const front = fx + fz > 2;
			const woods = front
				? radius > PLAZA_RADIUS + 1.8 && hash < 0.3
				: radius > PLAZA_RADIUS + 0.9 && hash < 0.72;
			if (woods) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.26) {
					kind = "cedar";
				} else if (hash > 0.6) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, 0, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.35,
					seed: Math.round(hash * 1000),
				});
			} else if (hash > (front ? 0.78 : 0.84)) {
				bushes.push({ at: [fx, 0, fz], scale: 0.8, seed: x * 31 + y });
			} else if (hash > (front ? 0.48 : 0.62)) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** Lamps and benches round the plaza's edge, between the landmarks. */
export function furniture() {
	const lamps: Vec3[] = [];
	for (let index = 0; index < 8; index++) {
		const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
		lamps.push([
			Math.cos(angle) * (PLAZA_RADIUS - 0.5),
			0,
			Math.sin(angle) * (PLAZA_RADIUS - 0.5),
		]);
	}
	const benches: PlacedProp[] = [
		{ at: [4.3, 0, 0.9], yaw: -Math.PI / 2 },
		{ at: [0.9, 0, 4.3], yaw: 0 },
		{ at: [3.4, 0, -3], yaw: -Math.PI * 0.75 },
	];
	return { benches, lamps };
}
