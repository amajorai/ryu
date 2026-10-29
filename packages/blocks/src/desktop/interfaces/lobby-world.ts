import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { type LobbyMember, SQUAD_SIZE } from "./lobby-model.ts";

/**
 * The Lobby as a diorama on the 3D game kit (game3d-stage.tsx): a paved
 * game plaza on an island. The squad stands on a lit round podium in the
 * middle, the quest board stands at the front left, the play portal glows
 * at the back right and the recent-matches board stands at the back left.
 * All positions are world units on the ground plane (x right, z toward the
 * viewer; the camera looks from +x, +z, so screen right runs along
 * (1, 0, -1) and screen up along (-1, 0, -1)). Pure so it is testable.
 */

/** The podium: its radius and the height its top stands at. */
export const PODIUM_RADIUS = 3.2;
export const PODIUM_HEIGHT = 0.42;
/** The paved plaza round the podium. */
export const PLAZA_RADIUS = 6.4;
/** Space between squad spots along the screen's horizontal. */
const SPOT_STEP = 1.85;
/** How many recent matches the board shows. */
export const RECENT_MATCHES = 4;
/** The diorama's half size, for the camera and the island. */
const HALF = 5.6;

/** Screen right on the ground, as a unit vector. */
const ACROSS: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];

export interface LobbySpot {
	at: [number, number];
	/** The member standing here, or null for an open slot. */
	member: LobbyMember | null;
}

export interface LobbyWorld {
	bounds: { maxX: number; maxZ: number; minX: number; minZ: number };
	/** The recent-matches board, and the threads pinned to it. */
	matches: { at: [number, number]; threads: InterfaceThread[] };
	/** The play portal. */
	portal: [number, number];
	/** The quest board. */
	questBoard: [number, number];
	/** One spot per squad place, left to right on screen. */
	spots: LobbySpot[];
}

/** Every thread the squad is in, newest first, each once. */
export function squadThreads(squad: readonly LobbyMember[]): InterfaceThread[] {
	const seen = new Map<string, InterfaceThread>();
	for (const member of squad) {
		for (const thread of member.threads) {
			seen.set(thread.id, thread);
		}
	}
	return [...seen.values()].sort(
		(a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
	);
}

/** Lays the plaza out: the squad's spots, the boards and the portal. */
export function layoutLobbyWorld(
	squad: readonly LobbyMember[],
	openSlots = true,
	size = SQUAD_SIZE
): LobbyWorld {
	const places = openSlots ? size : Math.max(1, Math.min(size, squad.length));
	const spots: LobbySpot[] = [];
	for (let index = 0; index < places; index++) {
		const offset = (index - (places - 1) / 2) * SPOT_STEP;
		spots.push({
			at: [ACROSS[0] * offset, ACROSS[1] * offset],
			member: squad[index] ?? null,
		});
	}
	return {
		bounds: { maxX: HALF, maxZ: HALF, minX: -HALF, minZ: -HALF },
		matches: {
			at: [-5.4, -0.6],
			threads: squadThreads(squad).slice(0, RECENT_MATCHES),
		},
		portal: [1, -5.3],
		questBoard: [-0.8, 5.2],
		spots,
	};
}
