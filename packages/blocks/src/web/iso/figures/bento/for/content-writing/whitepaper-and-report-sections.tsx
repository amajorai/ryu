import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Whitepaper and report sections: a book press. The report's sections sit as
 * signatures on the bed, squared up under one platen so they come out even,
 * the same terms throughout; one section's tab (the lit part) sticks out.
 */

const PLATE = { x: -82, y: -56, w: 164, d: 112, r: 8 };
const BED = { x: -56, y: -38, w: 112, d: 76, r: 4 };
const BED_H = 10;
const POST_X = 46;
const POST_R = 5;
const SECTION_H = 5;
const SECTIONS = 4;
const STACK = { x: -30, y: -26, w: 60, d: 52, r: 1.5 };
const PLATEN_Z = BED_H + SECTION_H * SECTIONS;
const BAR_Z = 70;
const BAR_H = 10;
const WHEEL_Z = BAR_Z + BAR_H + 6;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, WHEEL_Z + 4],
	[0, -20, WHEEL_Z + 4],
]);

function post(x: number) {
	s.solid(cylinder(x, 0, POST_R, BED_H, BAR_Z - BED_H, s.P, 28));
}

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 1));
post(-POST_X);
// The sections, squared up; the third carries a tab.
for (let index = 0; index < SECTIONS; index++) {
	const z = BED_H + index * SECTION_H;
	const nudge = index % 2 === 0 ? 0 : 1.2;
	s.solid(slabOf({ ...STACK, x: STACK.x + nudge }, z, SECTION_H, s.P, 2, 0.3), {
		crease: "none",
	});
	s.line(
		faceLine(
			s,
			"y",
			STACK.y + STACK.d,
			STACK.x + 4,
			STACK.x + STACK.w - 4,
			z + 2.5
		),
		{
			tone: "faint",
		}
	);
	if (index === 2) {
		s.solid(
			slabOf(
				{ x: 4, y: STACK.y + STACK.d, w: 14, d: 7, r: 1 },
				z + 1,
				3,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	}
}
// Platen and spindle.
s.solid(
	slabOf({ x: -36, y: -32, w: 72, d: 64, r: 3 }, PLATEN_Z, 6, s.P, 4, 0.8)
);
s.solid(cylinder(0, 0, 7, PLATEN_Z + 6, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(0, 0, 4, PLATEN_Z + 9, BAR_Z - PLATEN_Z - 9, s.P, 24));
s.line(knurl(0, 0, 4, PLATEN_Z + 10, BAR_Z, 18, s.P), { tone: "lo" });
post(POST_X);
// Crossbar with nuts over the posts.
s.solid(
	slabOf(
		{ x: -POST_X - 9, y: -9, w: 2 * POST_X + 18, d: 18, r: 3 },
		BAR_Z,
		BAR_H,
		s.P,
		4,
		1
	)
);
for (const x of [-POST_X, POST_X]) {
	s.solid(cylinder(x, 0, 6, BAR_Z + BAR_H, 3, s.P, 6), { tone: "lo" });
}
// Handwheel on top of the spindle.
s.solid(cylinder(0, 0, 3.5, BAR_Z + BAR_H, 6, s.P, 20));
s.solid(cylinder(0, 0, 20, WHEEL_Z, 3, s.P, 48, 0.4));
s.line(ring(0, 0, 15, WHEEL_Z + 3, s.P, 48), { tone: "lo" });
for (const [dx, dy] of [
	[15, 0],
	[-15, 0],
	[0, 15],
	[0, -15],
] as const) {
	s.line(lineOnTop([0, 0], [dx, dy], WHEEL_Z + 3, s.P), { tone: "faint" });
}
s.solid(cylinder(0, 0, 5, WHEEL_Z + 3, 2, s.P, 24), { tone: "lo" });
screws(
	s,
	[
		[BED.x + 6, BED.y + BED.d - 6],
		[BED.x + BED.w - 6, BED.y + BED.d - 6],
	],
	BED_H,
	1.4
);

export const drawing = cardDrawing(s);
