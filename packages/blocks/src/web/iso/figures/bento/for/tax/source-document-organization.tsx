import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Source document organization: a desk sorter. Each slot between its
 * dividers holds one kind of form, with a lamp on the lip in front of it; one
 * slot is still empty and its lamp is on (the lit part): that form is missing.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const BASE = { x: -78, y: -32, w: 136, d: 62, r: 4 };
const BASE_H = 6;
const SLOT = 26;
const DIV_D = 48;
const DIV_H = 34;
const SLOTS = 5;
const MISSING = 3;
// Papers per slot: offset in the slot and height above the base.
const PAPERS: [number, number][][] = [
	[
		[5, 24],
		[11, 20],
		[17, 22],
	],
	[
		[6, 26],
		[13, 23],
	],
	[
		[5, 20],
		[10, 22],
		[15, 18],
		[20, 21],
	],
	[],
	[
		[8, 25],
		[15, 21],
	],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BASE.x, BASE.y, BASE_H + DIV_H + 2],
]);

const slotX = (index: number) => BASE.x + 4 + index * SLOT;

function divider(x: number) {
	const plan = { x: x - 1.4, y: BASE.y + 3, w: 2.8, d: DIV_D, r: 0.6 };
	s.solid(slabOf(plan, BASE_H, DIV_H, s.P, 2, 0.4));
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 2), BASE_H, s.P, 4), { tone: "faint" });
for (let i = 0; i < SLOTS; i++) {
	divider(slotX(i));
	for (const [offset, height] of PAPERS[i] ?? []) {
		const paper = {
			x: slotX(i) + offset - 0.6,
			y: BASE.y + 7,
			w: 1.2,
			d: DIV_D - 8,
			r: 0.3,
		};
		s.solid(slabOf(paper, BASE_H, height, s.P, 2), { crease: "none" });
	}
}
divider(slotX(SLOTS));
// The front lip: a lamp under each slot, and a label holder on its face.
const lip = BASE.y + DIV_D + 8;
for (let i = 0; i < SLOTS; i++) {
	lamp(s, [slotX(i) + SLOT / 2, lip], BASE_H, {
		lit: i === MISSING,
		radius: 2.6,
	});
	s.line(
		faceRect(
			s,
			"y",
			BASE.y + BASE.d,
			slotX(i) + 5,
			slotX(i) + SLOT - 5,
			1.5,
			4.5
		),
		{ tone: "lo" }
	);
}
screws(
	s,
	[
		[BASE.x + BASE.w - 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, lip],
	],
	BASE_H,
	1.4
);

export const drawing = cardDrawing(s);
