import { describe, expect, test } from "bun:test";
import {
	fitBoxes,
	MAX_NUDGE,
	type PlateBox,
	partOnStage,
	plateFitBox,
	platesOverlap,
	STAGE_MARGIN,
	separatePlates,
	stageShift,
	YOU_SPOT_GAP,
} from "./game3d-plates.ts";

const plate = (x: number, y: number, width = 80, height = 28): PlateBox => ({
	height,
	width,
	x,
	y,
});

describe("separatePlates", () => {
	test("leaves plates that do not touch where they are", () => {
		const boxes = [plate(0, 0), plate(200, 0), plate(0, 100)];
		expect(separatePlates(boxes)).toEqual([
			[0, 0],
			[0, 0],
			[0, 0],
		]);
	});

	test("stacks two plates that overlap mostly sideways", () => {
		const boxes = [plate(0, 0), plate(20, 6)];
		const nudges = separatePlates(boxes);
		expect(platesOverlap(boxes, nudges)).toBe(false);
		// Pushed apart vertically, half each, the lower one further down.
		expect(nudges[0]?.[1]).toBeLessThan(0);
		expect(nudges[1]?.[1]).toBeGreaterThan(0);
		expect(nudges[0]?.[0]).toBe(0);
	});

	test("parts a row of name plates that touch at their ends", () => {
		const boxes = [plate(0, 0), plate(76, 2), plate(152, 0)];
		const nudges = separatePlates(boxes);
		expect(platesOverlap(boxes, nudges)).toBe(false);
		// The overlap is small across, so they shift sideways, not stack.
		for (const [, dy] of nudges) {
			expect(Math.abs(dy)).toBeLessThanOrEqual(1);
		}
	});

	test("untangles a small crowd", () => {
		const boxes = [plate(0, 0), plate(14, 5), plate(28, 10)];
		expect(platesOverlap(boxes, separatePlates(boxes))).toBe(false);
	});

	test("never nudges past the cap, however crowded", () => {
		const boxes = Array.from({ length: 8 }, (_, index) =>
			plate(index * 6, index * 2)
		);
		for (const [dx, dy] of separatePlates(boxes)) {
			expect(Math.abs(dx)).toBeLessThanOrEqual(MAX_NUDGE);
			expect(Math.abs(dy)).toBeLessThanOrEqual(MAX_NUDGE);
		}
	});

	test("is stable for plates stacked exactly on each other", () => {
		const boxes = [plate(0, 0), plate(0, 0)];
		const first = separatePlates(boxes);
		expect(separatePlates(boxes)).toEqual(first);
		expect(platesOverlap(boxes, first)).toBe(false);
	});
});

const gapBetween = (
	a: PlateBox,
	b: PlateBox,
	na: readonly number[],
	nb: readonly number[]
) => {
	const ax = a.x + (na[0] ?? 0);
	const ay = a.y + (na[1] ?? 0);
	const bx = b.x + (nb[0] ?? 0);
	const by = b.y + (nb[1] ?? 0);
	const gx = Math.abs(bx - ax) - (a.width + b.width) / 2;
	const gy = Math.abs(by - ay) - (a.height + b.height) / 2;
	return Math.max(gx, gy);
};

describe("you-spot gap", () => {
	test("two queue plates keep at least YOU_SPOT_GAP, even off whole px", async () => {
		const { PLATE_GAP, YOU_SPOT_GAP } = await import("./game3d-plates.ts");
		const queue = [
			{ ...plate(0.3, 0.4, 80, 27), youSpot: true },
			{ ...plate(0.7, 29.9, 80, 27), youSpot: true },
		];
		const [up, down] = separatePlates(queue);
		expect(
			gapBetween(
				queue[0] as PlateBox,
				queue[1] as PlateBox,
				up ?? [],
				down ?? []
			)
		).toBeGreaterThanOrEqual(YOU_SPOT_GAP);
		const mixed = [plate(0, 0), { ...plate(0, 30), youSpot: true }];
		const [a, b] = separatePlates(mixed);
		const mixedGap = gapBetween(
			mixed[0] as PlateBox,
			mixed[1] as PlateBox,
			a ?? [],
			b ?? []
		);
		expect(mixedGap).toBeLessThan(YOU_SPOT_GAP);
		expect(mixedGap).toBeGreaterThanOrEqual(PLATE_GAP - 1);
	});

	test("a crowded queue (4 slots, a tray, a tally) keeps every queue gap", async () => {
		const { YOU_SPOT_GAP } = await import("./game3d-plates.ts");
		const crowd: PlateBox[] = [
			{ ...plate(10.2, 100.3, 76, 27), youSpot: true },
			{ ...plate(14.6, 121.8, 81, 27), youSpot: true },
			{ ...plate(8.1, 140.5, 79, 27), youSpot: true },
			{ ...plate(12.9, 162.2, 70, 27), youSpot: true },
			{ ...plate(60.4, 150.7, 27, 27), youSpot: true },
			{ ...plate(70.5, 118.1, 64, 23), youSpot: true },
		];
		const nudges = separatePlates(crowd);
		for (let i = 0; i < crowd.length; i++) {
			for (let j = i + 1; j < crowd.length; j++) {
				expect(
					gapBetween(
						crowd[i] as PlateBox,
						crowd[j] as PlateBox,
						nudges[i] ?? [],
						nudges[j] ?? []
					)
				).toBeGreaterThanOrEqual(YOU_SPOT_GAP);
			}
		}
	});
});

describe("fitBoxes", () => {
	test("the same plates under two camera scales give the same fit", async () => {
		const { fitBoxes } = await import("./game3d-plates.ts");
		const room = {
			height: 844,
			insets: { bottom: 80, left: 0, right: 0, top: 70 },
			width: 390,
		};
		const pad = { above: 1, below: 0.5, max: 2, side: 0.5 };
		const centre: [number, number] = [195, 422];
		// Plates at the base camera, one with a bubble reaching up-right.
		const base = [
			{ bottom: 13, left: -40, right: 40, top: -13, x: 120, y: 400 },
			{ bottom: 13, left: -30, right: 150, top: -50, x: 260, y: 460 },
			{ bottom: 12, left: -14, right: 14, top: -12, x: 180, y: 520 },
		];
		const zoom = 20;
		const atBase = fitBoxes(base, room, zoom, pad);
		// The same scene under a camera zoomed 1.4× about the centre.
		const s = 1.4;
		const zoomed = base.map((box) => ({
			...box,
			x: centre[0] + (box.x - centre[0]) * s,
			y: centre[1] + (box.y - centre[1]) * s,
		}));
		const toBase = (points: [number, number][]) =>
			points.map(([x, y]): [number, number] => [
				centre[0] + (x - centre[0]) / s,
				centre[1] + (y - centre[1]) / s,
			]);
		const refit = fitBoxes(
			zoomed,
			room,
			zoom,
			pad,
			{ right: 0, scale: 1, up: 0 },
			toBase
		);
		expect(refit?.scale).toBeCloseTo(atBase?.scale ?? 0, 6);
		expect(refit?.right).toBeCloseTo(atBase?.right ?? 0, 6);
		expect(refit?.up).toBeCloseTo(atBase?.up ?? 0, 6);
	});
});

describe("stageShift", () => {
	const room = { bottom: 600, left: 0, right: 400, top: 0 };
	test("a plate inside stays; one past an edge comes back by the margin", () => {
		expect(stageShift(plate(200, 300), room)).toEqual([0, 0]);
		// Hung right of an anchor near the right edge: 430 + 40 = 470 > 398.
		expect(stageShift(plate(430, 300), room)).toEqual([
			400 - STAGE_MARGIN - 470,
			0,
		]);
		expect(stageShift(plate(20.5, 300), room)).toEqual([
			STAGE_MARGIN + 40 - 20.5 + 0.5,
			0,
		]);
		expect(stageShift(plate(200, 5), room)).toEqual([0, STAGE_MARGIN + 9]);
		expect(stageShift(plate(200, 595), room)).toEqual([
			0,
			600 - STAGE_MARGIN - 609,
		]);
	});

	test("a plate wider than the stage keeps its left edge in", () => {
		const wide = plate(250, 300, 500);
		const [dx] = stageShift(wide, room);
		expect(250 + dx - 250).toBe(STAGE_MARGIN);
		const placed = plate(STAGE_MARGIN + 250, 300, 500);
		expect(stageShift(placed, room)).toEqual([0, 0]);
	});
});

describe("plateFitBox", () => {
	test("a side-hung plate fits the same under any zoom, from its anchor", () => {
		const room = {
			height: 844,
			insets: { bottom: 80, left: 0, right: 0, top: 70 },
			width: 390,
		};
		const pad = { above: 1, below: 0.5, max: 2, side: 0.5 };
		const centre: [number, number] = [195, 422];
		const canvas = { left: 0, top: 0 };
		// Anchors where the base camera projects them; the first plate hangs
		// right of its anchor (an alarm plate), the second is centred on it.
		const anchors: [number, number][] = [
			[100, 300],
			[260, 480],
		];
		const hang = [
			{ bottom: 12, left: 8, right: 128, top: -12 },
			{ bottom: 12, left: -30, right: 30, top: -12 },
		];
		const scene = (scale: number, withAnchor: boolean) =>
			anchors.map(([ax, ay], index) => {
				const x = centre[0] + (ax - centre[0]) * scale;
				const y = centre[1] + (ay - centre[1]) * scale;
				const offset = hang[index] ?? { bottom: 0, left: 0, right: 0, top: 0 };
				const plate = {
					bottom: y + offset.bottom,
					left: x + offset.left,
					right: x + offset.right,
					top: y + offset.top,
				};
				return plateFitBox({
					anchor: withAnchor ? [x, y] : null,
					canvas,
					nudge: [0, 0],
					plate,
					reach: plate,
				});
			});
		const s = 1.4;
		const toBase = (points: [number, number][]) =>
			points.map(([x, y]): [number, number] => [
				centre[0] + (x - centre[0]) / s,
				centre[1] + (y - centre[1]) / s,
			]);
		const zoom = 20;
		const unfitted = { right: 0, scale: 1, up: 0 };
		const atBase = fitBoxes(scene(1, true), room, zoom, pad);
		const refit = fitBoxes(scene(s, true), room, zoom, pad, unfitted, toBase);
		expect(refit?.scale).toBeCloseTo(atBase?.scale ?? 0, 6);
		expect(refit?.right).toBeCloseTo(atBase?.right ?? 0, 6);
		expect(refit?.up).toBeCloseTo(atBase?.up ?? 0, 6);
		// From the plate's own centre, the hang is scaled with the anchor:
		// the same scene fits differently once zoomed.
		const centred = fitBoxes(scene(1, false), room, zoom, pad);
		const drifted = fitBoxes(
			scene(s, false),
			room,
			zoom,
			pad,
			unfitted,
			toBase
		);
		expect(
			Math.abs((drifted?.right ?? 0) - (centred?.right ?? 0))
		).toBeGreaterThan(0.1);
	});

	test("takes the separation nudge back out of the reach and centre", () => {
		const plate = { bottom: 112, left: 40, right: 100, top: 88 };
		const box = plateFitBox({
			anchor: null,
			canvas: { left: 10, top: 20 },
			nudge: [6, -4],
			plate,
			reach: plate,
		});
		expect(box).toEqual({
			bottom: 12,
			left: -30,
			right: 30,
			top: -12,
			x: 64 - 10,
			y: 104 - 20,
		});
	});
});

describe("you-spot queues", () => {
	test("four stacked queue plates spread past MAX_NUDGE to keep the gap", () => {
		const queue = [0, 1, 2, 3].map(() => ({
			...plate(100, 100),
			youSpot: true,
		}));
		const nudges = separatePlates(queue);
		let closest = Number.POSITIVE_INFINITY;
		for (const [i, a] of queue.entries()) {
			for (const [j, b] of queue.entries()) {
				if (j <= i) {
					continue;
				}
				const [ax, ay] = nudges[i] ?? [0, 0];
				const [bx, by] = nudges[j] ?? [0, 0];
				const gap = Math.max(
					Math.abs(b.x + bx - a.x - ax) - (a.width + b.width) / 2,
					Math.abs(b.y + by - a.y - ay) - (a.height + b.height) / 2
				);
				closest = Math.min(closest, gap);
			}
		}
		expect(closest).toBeGreaterThanOrEqual(YOU_SPOT_GAP);
		// The clamp a name plate keeps would not have been enough.
		expect(
			Math.max(...nudges.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))))
		).toBeGreaterThan(MAX_NUDGE);
	});

	test("name plates still stop at MAX_NUDGE", () => {
		const crowd = [0, 1, 2, 3].map(() => plate(100, 100));
		for (const [x, y] of separatePlates(crowd)) {
			expect(Math.abs(x)).toBeLessThanOrEqual(MAX_NUDGE);
			expect(Math.abs(y)).toBeLessThanOrEqual(MAX_NUDGE);
		}
	});
});

describe("partOnStage", () => {
	test("a queue at the top edge spreads below the HUD, apart and inside", () => {
		// A 390 x 844 stage whose title plate covers the top 64px.
		const room = { bottom: 772, left: 16, right: 374, top: 64 };
		const queue = [0, 1, 2, 3].map(() => ({
			...plate(195, 70),
			youSpot: true,
		}));
		const nudges = partOnStage(queue, room);
		const placed = queue.map((box, index) => {
			const [dx, dy] = nudges[index] ?? [0, 0];
			return { ...box, x: box.x + dx, y: box.y + dy };
		});
		for (const box of placed) {
			expect(box.y - box.height / 2).toBeGreaterThanOrEqual(
				room.top + STAGE_MARGIN
			);
			expect(box.x - box.width / 2).toBeGreaterThanOrEqual(room.left);
			expect(box.x + box.width / 2).toBeLessThanOrEqual(room.right);
		}
		for (const [i, a] of placed.entries()) {
			for (const [j, b] of placed.entries()) {
				if (j > i) {
					const gap = Math.max(
						Math.abs(b.x - a.x) - (a.width + b.width) / 2,
						Math.abs(b.y - a.y) - (a.height + b.height) / 2
					);
					expect(gap).toBeGreaterThanOrEqual(YOU_SPOT_GAP);
				}
			}
		}
	});

	test("without a room it only parts", () => {
		const pair = [plate(100, 100), plate(100, 100)];
		expect(partOnStage(pair, null)).toEqual(separatePlates(pair));
	});
});

describe("figures as obstacles", () => {
	const figure = (x: number, y: number): PlateBox => ({
		figure: true,
		height: 60,
		width: 34,
		x,
		y,
	});
	const gapBetween = (a: PlateBox, b: PlateBox, [dx, dy]: [number, number]) =>
		Math.max(
			Math.abs(b.x - (a.x + dx)) - (a.width + b.width) / 2,
			Math.abs(b.y - (a.y + dy)) - (a.height + b.height) / 2
		);

	test("an alarm plate moves wholly off a figure; the figure stays", () => {
		const alarm = { ...plate(210, 200), clearsFigures: true };
		const body = figure(200, 210);
		const [move, still] = separatePlates([alarm, body]);
		expect(still).toEqual([0, 0]);
		expect(gapBetween(alarm, body, move ?? [0, 0])).toBeGreaterThanOrEqual(0);
	});

	test("name plates and other figures ignore figures", () => {
		const name = plate(200, 200);
		expect(separatePlates([name, figure(200, 210)])).toEqual([
			[0, 0],
			[0, 0],
		]);
		expect(separatePlates([figure(200, 200), figure(205, 205)])).toEqual([
			[0, 0],
			[0, 0],
		]);
	});

	test("with no figure near, an alarm parts like any plate", () => {
		const alarm = { ...plate(100, 100), clearsFigures: true };
		const other = plate(100, 100);
		expect(separatePlates([alarm, other])).toEqual(
			separatePlates([plate(100, 100), plate(100, 100)])
		);
	});
});

describe("name plates as obstacles for alarms", () => {
	test("an alarm moves wholly off a name plate; other plates share the move", () => {
		const alarm = { ...plate(100, 100), clearsFigures: true };
		const name = { ...plate(100, 100), namePlate: true };
		const [move, still] = separatePlates([alarm, name]);
		expect(still).toEqual([0, 0]);
		expect(Math.abs((move ?? [0, 0])[1])).toBeGreaterThanOrEqual(28 + 3 - 1);
		// A name plate and an ordinary plate split the move (whole px).
		const [a, b] = separatePlates([plate(100, 100), name]);
		expect(Math.abs((a?.[1] ?? 0) + (b?.[1] ?? 0))).toBeLessThanOrEqual(1);
		expect(Math.abs(b?.[1] ?? 0)).toBeGreaterThan(10);
	});
});

describe("alarm stacks", () => {
	test("stacked alarms never overlap, even pushed off a name plate", () => {
		// Two alarm rows over a name plate: moving each wholly off the plate
		// would drive one into the other; alarm against alarm has the last word.
		// A stack of two alarms between a neighbour's name plate and figure
		// (found by search: without the alarms' last word they overlap).
		const top = { ...plate(100, 100, 100), clearsFigures: true };
		const next = { ...plate(99, 69, 100), clearsFigures: true };
		const name = { ...plate(120, 61, 76, 27), namePlate: true };
		const body: PlateBox = {
			figure: true,
			height: 60,
			width: 34,
			x: 73,
			y: 87,
		};
		const boxes = [top, next, name, body];
		const nudges = separatePlates(boxes);
		const [a, b] = [0, 1].map((index) => {
			const box = boxes[index] as PlateBox;
			const [dx, dy] = nudges[index] ?? [0, 0];
			return { ...box, x: box.x + dx, y: box.y + dy };
		});
		expect(platesOverlap([a as PlateBox, b as PlateBox])).toBe(false);
	});
});

describe("boxed-in alarms", () => {
	test("an alarm between its figure and a neighbour's name plate climbs clear", () => {
		// Ed's alarm: Ed's figure on its left, Fa's name plate on its right,
		// too close to fit between.
		const alarm = { ...plate(100, 100, 90), clearsFigures: true };
		const body: PlateBox = {
			figure: true,
			height: 60,
			width: 34,
			x: 48,
			y: 105,
		};
		const name = { ...plate(160, 100, 60, 27), namePlate: true };
		const boxes = [alarm, body, name];
		const nudges = separatePlates(boxes);
		const [dx, dy] = nudges[0] ?? [0, 0];
		const moved = { ...alarm, x: alarm.x + dx, y: alarm.y + dy };
		expect(platesOverlap([moved, body])).toBe(false);
		expect(platesOverlap([moved, name])).toBe(false);
		expect(nudges[1]).toEqual([0, 0]);
	});
});

describe("alarms in a crowd", () => {
	test("arcade at 390: Ed's alarm finds a spot off every figure and name plate", () => {
		// Measured from arcade @390 live: a grid of stations, each a 27px name
		// plate over a figure, with Ed's alarm boxed in beside Ed's figure.
		const sq = (left: number, top: number, extra: Partial<PlateBox> = {}) => ({
			height: 27,
			width: 27,
			x: left + 13.5,
			y: top + 13.5,
			...extra,
		});
		const fig = (x: number, top: number): PlateBox => ({
			figure: true,
			height: 19,
			width: 24,
			x,
			y: top + 9.5,
		});
		const boxes: PlateBox[] = [
			sq(217, 405, { clearsFigures: true }),
			sq(166, 405, { clearsFigures: true }),
			sq(166, 374, { clearsFigures: true }),
			...[
				[173, 389],
				[130, 389],
				[230, 401],
				[180, 440],
				[130, 452],
				[220, 452],
				[230, 327],
			].map(([left, top]) => sq(left ?? 0, top ?? 0, { namePlate: true })),
			fig(143, 406),
			fig(194, 406),
			fig(244, 406),
			fig(143, 469),
			fig(194, 469),
			fig(244, 469),
			fig(244, 344),
		];
		const nudges = separatePlates(boxes);
		const placed = boxes.map((box, index) => {
			const [dx, dy] = nudges[index] ?? [0, 0];
			return { ...box, x: box.x + dx, y: box.y + dy };
		});
		const ed = placed[0] as PlateBox;
		for (const other of placed.slice(3)) {
			expect(platesOverlap([ed, other])).toBe(false);
		}
		// Every alarm stays apart from the others.
		expect(platesOverlap(placed.slice(0, 3))).toBe(false);
	});
});
