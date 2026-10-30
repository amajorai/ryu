import type { Vec3 } from "./game3d-palette.ts";
import { FACE_CAMERA, type VillagerPose } from "./game3d-villager.tsx";
import {
	CHAIR_OUT,
	type OfficeDesk,
	type WorkerState,
} from "./workers-model.ts";

/** The workers diorama's shared measures and desk-frame geometry. */

export const SLAB = 0.16;
export const WALL_HEIGHT = 2.3;
export const WALL_THICK = 0.18;
/** Desk and chair, at villager scale: a chibi's torso shows over the desk. */
export const DESK_TOP = 0.56;
export const DESK_WIDTH = 1.5;
export const SEAT = 0.3;
/** The monitor's screen: centre height over the floor, width and height. */
export const SCREEN_Y = 1.3;
export const SCREEN: [number, number] = [0.82, 0.48];

/** A worker's villager pose from its state. */
export function workerPose(state: WorkerState): VillagerPose {
	if (state === "attention") {
		return "failed";
	}
	if (state === "your-turn") {
		return "needs-you";
	}
	return state === "working" ? "working" : "idle";
}

/** The chair sits a little right of the screen: it shows over a shoulder. */
export const SEAT_X = 0.3;
/** Desks are turned to face the camera, so screens show over shoulders. */
export const DESK_YAW = FACE_CAMERA;

/** Facing the screen (back to the camera) or turned round to the room. */
export function facingOf(state: WorkerState): number {
	return state === "working" || state === "idle"
		? DESK_YAW + Math.PI
		: FACE_CAMERA;
}

/** A desk-frame point (chair toward +z) in the world. */
export function deskPoint(x: number, z: number, local: Vec3): Vec3 {
	return turned([x, 0, z], DESK_YAW, local);
}

/** Turns `local` by `yaw` about the vertical axis and moves it to `at`. */
export function turned(at: Vec3, yaw: number, local: Vec3): Vec3 {
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return [
		at[0] + local[0] * cos + local[2] * sin,
		at[1] + local[1],
		at[2] - local[0] * sin + local[2] * cos,
	];
}

/** The bistro table's offset from the coffee counter, and its top. */
export const BISTRO: [number, number] = [0.1, 1.35];
export const BISTRO_TOP = 0.53;

/** The inbox tray's top, over the floor: folders lie on it. */
export const INBOX_TOP = 0.66;

/** Where a desk's worker sits, in the world. */
export function chairOf(desk: OfficeDesk): Vec3 {
	return deskPoint(desk.x, desk.z, [SEAT_X, SLAB + SEAT, CHAIR_OUT]);
}

/** A desk-frame offset, turned with the desks (for `ActStation` layouts). */
export function deskOffset(local: Vec3): Vec3 {
	return turned([0, 0, 0], DESK_YAW, local);
}
