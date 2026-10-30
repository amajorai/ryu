import type { Vec3 } from "./game3d-palette.ts";

/** Offset `a` by `b`. */
export const plus = (a: Vec3, b: Vec3): Vec3 => [
	a[0] + b[0],
	a[1] + b[1],
	a[2] + b[2],
];
