import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Out of the way: a phone lying face up in a dock between two end stops. The screen keeps its
 * room; only the small island capsule at the top edge (the lit part) sits
 * proud of the glass, ready to open when it has something to show.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const STOP_H = 12;
/** One end stop of the dock, a block with a slot the phone's end sits in. */
const endStop = (x: number) => {
	const plan = { x, y: -18, w: 8, d: 36, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, STOP_H, s.P, 3, 0.6));
	s.line(lineOnTop([x + 4, -12], [x + 4, 12], STOP_H, s.P), { tone: "lo" });
};
const PHONE = { x: -76, y: -36, w: 152, d: 72, r: 12 };
const PHONE_H = 7;
const GLASS = insetPlan(PHONE, 4);
const TOP = PHONE_H;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, STOP_H + 2]]);

benchPlate(s, PLATE);
endStop(-86);
// Side keys on the far edge, behind the body.
for (const x of [-30, -10]) {
	s.solid(slabOf({ x, y: PHONE.y - 1.6, w: 14, d: 2, r: 0.8 }, 2, 3, s.P, 2));
}
s.halo(PHONE, 0);
s.solid(slabOf(PHONE, 0, PHONE_H, s.P, 8, 1));
s.solid(slabOf(GLASS, TOP, 0.6, s.P, 6), { tone: "lo", crease: "none" });
// Content on the screen, as rows of rule lines.
const rows: [number, number][] = [
	[-12, 70],
	[-4, 52],
	[4, 64],
	[12, 40],
	[20, 58],
];
for (const [y, length] of rows) {
	s.line(lineOnTop([-34, y], [-34 + length, y], TOP + 0.6, s.P), {
		tone: "faint",
	});
}
s.line(planOutline({ x: 6, y: 24, w: 30, d: 4, r: 2 }, TOP + 0.6, s.P, 3), {
	tone: "lo",
});
// The island capsule at the top edge, raised off the glass.
const island = { x: -66, y: -20, w: 14, d: 40, r: 7 };
s.halo(island, TOP + 0.6, 3);
s.solid(slabOf(island, TOP + 0.6, 2.4, s.P, 6, 0.4), { lit: true });
s.solid(cylinder(-59, -12, 1.6, TOP + 3, 0.6, s.P, 16), { tone: "lo" });
endStop(78);
screws(
	s,
	[
		[-82, -12],
		[82, 12],
	],
	STOP_H,
	1.2
);

export const drawing = cardDrawing(s);
