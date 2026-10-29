import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Fix a broken pipeline: a duct run on saddle stands, one section per step.
 * The joint that failed is wrapped in a bolted repair sleeve (the lit part);
 * the wrench that fitted it lies in front, ready for you to check the work.
 */

const PLATE = { x: -104, y: -46, w: 208, d: 92, r: 8 };
const DUCT_Y = -14;
const DUCT_D = 16;
const Z0 = 14;
const Z1 = 28;
const SEGMENTS: [number, number][] = [
	[-90, -38],
	[-34, 14],
	[18, 88],
];
const STANDS = [-64, -10, 52];
const BROKEN = 16;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, DUCT_Y, 40]]);

function stand(x: number) {
	const plan = { x: x - 6, y: DUCT_Y - 4, w: 12, d: DUCT_D + 8, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 3, s.P, 3, 0.4), { tone: "lo" });
	s.solid(
		slabOf(
			{ x: x - 3, y: DUCT_Y - 1, w: 6, d: DUCT_D + 2, r: 1 },
			3,
			Z0 - 3,
			s.P,
			2
		)
	);
}

function segment([x0, x1]: [number, number]) {
	s.solid(
		slabOf(
			{ x: x0, y: DUCT_Y, w: x1 - x0, d: DUCT_D, r: 3 },
			Z0,
			Z1 - Z0,
			s.P,
			4,
			0.8
		)
	);
	s.line(
		lineOnTop(
			[x0 + 4, DUCT_Y + DUCT_D / 2],
			[x1 - 4, DUCT_Y + DUCT_D / 2],
			Z1,
			s.P
		),
		{ tone: "faint" }
	);
}

function flange(x: number, lit = false) {
	const width = lit ? 16 : 5;
	const grow = lit ? 4 : 2.5;
	s.solid(
		slabOf(
			{
				x: x - width / 2,
				y: DUCT_Y - grow,
				w: width,
				d: DUCT_D + grow * 2,
				r: 2,
			},
			Z0 - grow,
			Z1 - Z0 + grow * 2,
			s.P,
			3,
			0.6
		),
		{ lit, tone: lit ? "hi" : "lo" }
	);
	if (lit) {
		screws(
			s,
			[
				[x - 4, DUCT_Y + DUCT_D / 2],
				[x + 4, DUCT_Y + DUCT_D / 2],
			],
			Z1 + grow,
			1.3
		);
	}
}

benchPlate(s, PLATE);
stand(STANDS[0] ?? 0);
segment(SEGMENTS[0] ?? [0, 0]);
flange(-36);
stand(STANDS[1] ?? 0);
segment(SEGMENTS[1] ?? [0, 0]);
// Hand valve on top of the middle step.
s.solid(cylinder(-18, DUCT_Y + DUCT_D / 2, 2, Z1, 6, s.P, 16), { tone: "lo" });
s.solid(cylinder(-18, DUCT_Y + DUCT_D / 2, 8, Z1 + 6, 2.4, s.P, 36));
s.line(knurl(-18, DUCT_Y + DUCT_D / 2, 8, Z1 + 6, Z1 + 8.4, 24, s.P), {
	tone: "lo",
});
stand(STANDS[2] ?? 0);
segment(SEGMENTS[2] ?? [0, 0]);
flange(BROKEN, true);
// End cap on the last step.
flange(88);
// The wrench lying on the bench in front.
const wrench = { x: -46, y: 24, w: 54, d: 7, r: 3 };
s.halo(wrench, 0);
s.solid(slabOf(wrench, 0, 2.4, s.P, 3, 0.4), { tone: "lo" });
s.solid(cylinder(12, 27.5, 9, 0, 2.4, s.P, 32, 0.4), { tone: "lo" });
s.line(ring(12, 27.5, 4.5, 2.4, s.P, 6), { tone: "mid" });

export const drawing = cardDrawing(s);
