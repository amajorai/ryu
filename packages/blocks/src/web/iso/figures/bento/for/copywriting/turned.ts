import {
	extrude,
	type Plane,
	type Projection,
} from "../../../../kit/iso-kit.ts";

/*
 * A thin rectangular slab turned in plan: `length` runs along `angle`
 * (radians, 0 = +x) from `origin`, `width` across it. Used for the fanned
 * cards of the ad variation figure.
 */
export function turnedSlab(
	origin: Plane,
	angle: number,
	[from, to]: [number, number],
	width: number,
	z: number,
	height: number,
	P: Projection
) {
	const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
	const [vx, vy] = [-uy * (width / 2), ux * (width / 2)];
	const at = (along: number, side: 1 | -1): Plane => [
		origin[0] + ux * along + vx * side,
		origin[1] + uy * along + vy * side,
	];
	return extrude(
		[at(from, -1), at(to, -1), at(to, 1), at(from, 1)],
		z,
		height,
		P
	);
}

/** A point `distance` along `angle` from `origin`, in plan. */
export function along(origin: Plane, angle: number, distance: number): Plane {
	return [
		origin[0] + Math.cos(angle) * distance,
		origin[1] + Math.sin(angle) * distance,
	];
}
