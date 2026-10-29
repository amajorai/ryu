import type {
	Color,
	Euler,
	Material,
	Matrix4,
	Object3D,
	Quaternion,
	Vector3,
} from "three";
import { tileHash } from "./world-village.ts";

/**
 * Scratch math objects cloned from a live scene object.
 *
 * The world's 3D modules import `three` for types only and take every runtime
 * class from objects React Three Fiber already created. That keeps a single
 * copy of three.js in the bundle (the one R3F renders with), even in
 * dev servers that pre-bundle three into R3F's chunk.
 */
export interface MathKit {
	color: Color | null;
	euler: Euler;
	matrix: Matrix4;
	position: Vector3;
	quaternion: Quaternion;
	scale: Vector3;
}

const kits = new WeakMap<Object3D, MathKit>();

function materialColor(source: Object3D): Color | null {
	const material = (source as Object3D & { material?: Material | Material[] })
		.material;
	const single = Array.isArray(material) ? material[0] : material;
	const color = (single as (Material & { color?: Color }) | undefined)?.color;
	return color ? color.clone() : null;
}

/** Reusable scratch objects for `source` (created once per object). */
export function mathKit(source: Object3D): MathKit {
	const cached = kits.get(source);
	if (cached) {
		return cached;
	}
	const kit: MathKit = {
		color: materialColor(source),
		euler: source.rotation.clone(),
		matrix: source.matrix.clone(),
		position: source.position.clone(),
		quaternion: source.quaternion.clone(),
		scale: source.scale.clone(),
	};
	kits.set(source, kit);
	return kit;
}

/** Three.js constant values, typed, without importing three at runtime. */
export const BACK_SIDE = 1 as const;
export const DOUBLE_SIDE = 2 as const;
export const ADDITIVE_BLENDING = 2 as const;

export function pick<T>(items: readonly T[], seed: number): T {
	return items[Math.abs(seed) % items.length] as T;
}

/** Deterministic 0..1 jitter for scenery placement. */
export function jitter(x: number, y: number, salt: number): number {
	return tileHash(x * 7 + salt, y * 13 - salt) / 1000;
}
