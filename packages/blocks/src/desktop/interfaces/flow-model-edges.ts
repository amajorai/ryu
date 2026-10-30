import { FLOW_GEOMETRY } from "./flow-model-types.ts";

export function straight(
	from: [number, number],
	to: [number, number]
): [number, number][] {
	return [from, from, to, to];
}

export function elbow(
	from: [number, number],
	turnX: number,
	to: [number, number]
): [number, number][] {
	return [from, [turnX, from[1]], [turnX, to[1]], to];
}

function distance(a: [number, number], b: [number, number]): number {
	return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function toward(
	from: [number, number],
	to: [number, number],
	length: number
): [number, number] {
	const total = distance(from, to);
	if (total === 0) {
		return from;
	}
	const ratio = length / total;
	return [
		from[0] + (to[0] - from[0]) * ratio,
		from[1] + (to[1] - from[1]) * ratio,
	];
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A four-point edge as an SVG path with rounded corners. The command shape is
 * fixed (M L Q L Q L) even for straight edges, so motion can morph between
 * any two layouts.
 */
export function edgePath(
	points: readonly [number, number][],
	radius: number = FLOW_GEOMETRY.corner
): string {
	const [start, first, second, end] = points as [
		[number, number],
		[number, number],
		[number, number],
		[number, number],
	];
	const corner = (
		before: [number, number],
		at: [number, number],
		after: [number, number]
	) => {
		const room = Math.min(
			radius,
			distance(before, at) / 2,
			distance(at, after) / 2
		);
		return [toward(at, before, room), toward(at, after, room)] as const;
	};
	const [inA, outA] = corner(start, first, second);
	const [inB, outB] = corner(first, second, end);
	const p = ([x, y]: [number, number]) => `${round(x)} ${round(y)}`;
	return `M ${p(start)} L ${p(inA)} Q ${p(first)} ${p(outA)} L ${p(inB)} Q ${p(second)} ${p(outB)} L ${p(end)}`;
}
