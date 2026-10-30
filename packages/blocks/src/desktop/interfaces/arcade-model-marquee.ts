import type { MarqueeShape } from "./arcade-model.ts";

export interface Point {
	x: number;
	y: number;
}

/** Marquee outline in a `width` x `height` box, as an SVG path. */
export function marqueePath(
	shape: MarqueeShape,
	width: number,
	height: number
): string {
	const w = width;
	const h = height;
	if (shape === "arch") {
		return `M0 ${h} V26 C0 8 ${w * 0.22} 0 ${w / 2} 0 C${w * 0.78} 0 ${w} 8 ${w} 26 V${h} Z`;
	}
	if (shape === "crown") {
		return `M0 ${h} V18 H${w * 0.2} V8 H${w * 0.34} V0 H${w * 0.66} V8 H${w * 0.8} V18 H${w} V${h} Z`;
	}
	return `M8 0 H${w - 8} Q${w} 0 ${w} 8 V${h} H0 V8 Q0 0 8 0 Z`;
}

function cubicPoint(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number
): Point {
	const u = 1 - t;
	return {
		x:
			u * u * u * p0.x +
			3 * u * u * t * p1.x +
			3 * u * t * t * p2.x +
			t ** 3 * p3.x,
		y:
			u * u * u * p0.y +
			3 * u * u * t * p1.y +
			3 * u * t * t * p2.y +
			t ** 3 * p3.y,
	};
}

/** The closed loop the bulbs sit on, `inset` inside the marquee outline. */
function bulbLoop(
	shape: MarqueeShape,
	width: number,
	height: number,
	inset: number
): Point[] {
	const left = inset;
	const right = width - inset;
	const bottom = height - inset;
	if (shape === "arch") {
		const points: Point[] = [{ x: left, y: bottom }];
		const start = { x: left, y: 26 };
		const mid = { x: width / 2, y: inset };
		const end = { x: right, y: 26 };
		for (let step = 0; step <= 12; step += 1) {
			points.push(
				cubicPoint(
					start,
					{ x: left, y: 10 + inset / 2 },
					{ x: width * 0.22, y: inset },
					mid,
					step / 12
				)
			);
		}
		for (let step = 1; step <= 12; step += 1) {
			points.push(
				cubicPoint(
					mid,
					{ x: width * 0.78, y: inset },
					{ x: right, y: 10 + inset / 2 },
					end,
					step / 12
				)
			);
		}
		points.push({ x: right, y: bottom });
		return points;
	}
	if (shape === "crown") {
		const step1 = 18 + inset;
		const step2 = 8 + inset;
		const top = inset;
		return [
			{ x: left, y: bottom },
			{ x: left, y: step1 },
			{ x: width * 0.2 + inset, y: step1 },
			{ x: width * 0.2 + inset, y: step2 },
			{ x: width * 0.34 + inset, y: step2 },
			{ x: width * 0.34 + inset, y: top },
			{ x: width * 0.66 - inset, y: top },
			{ x: width * 0.66 - inset, y: step2 },
			{ x: width * 0.8 - inset, y: step2 },
			{ x: width * 0.8 - inset, y: step1 },
			{ x: right, y: step1 },
			{ x: right, y: bottom },
		];
	}
	return [
		{ x: left, y: bottom },
		{ x: left, y: inset },
		{ x: right, y: inset },
		{ x: right, y: bottom },
	];
}

/**
 * `count` evenly spaced bulb centres around the marquee (up the left side,
 * over the top, down the right, and back along the bottom).
 */
export function marqueeBulbs(
	shape: MarqueeShape,
	width: number,
	height: number,
	count: number,
	inset = 6
): Point[] {
	const loop = bulbLoop(shape, width, height, inset);
	const first = loop[0];
	if (!first || count <= 0) {
		return [];
	}
	const closed = [...loop, first];
	const lengths: number[] = [0];
	for (let index = 1; index < closed.length; index += 1) {
		const a = closed[index - 1] ?? first;
		const b = closed[index] ?? first;
		lengths.push((lengths[index - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
	}
	const total = lengths.at(-1) ?? 0;
	const bulbs: Point[] = [];
	let segment = 1;
	for (let bulb = 0; bulb < count; bulb += 1) {
		const target = (bulb / count) * total;
		while (segment < closed.length - 1 && (lengths[segment] ?? 0) < target) {
			segment += 1;
		}
		const a = closed[segment - 1] ?? first;
		const b = closed[segment] ?? first;
		const from = lengths[segment - 1] ?? 0;
		const span = (lengths[segment] ?? 0) - from || 1;
		const t = (target - from) / span;
		bulbs.push({
			x: Math.round((a.x + (b.x - a.x) * t) * 10) / 10,
			y: Math.round((a.y + (b.y - a.y) * t) * 10) / 10,
		});
	}
	return bulbs;
}
