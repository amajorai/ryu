import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRules, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * New Tab home: a small desk console. Across the back runs the smart bar, a
 * long input slot with its cursor block (the lit part) ready for a request;
 * in front sits a tray of recent chat cards, and on the right a turntable of
 * agent tokens turns one of them to the pointer.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const CONSOLE = { x: -88, y: -44, w: 116, d: 88, r: 5 };
const CON_H = 10;
const BAR = { x: -80, y: -38, w: 100, d: 20, r: 4 };
const BAR_H = 8;
const TABLE: [number, number] = [62, 6];
const TABLE_R = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TABLE[0], TABLE[1], 30],
	[-30, -30, CON_H + BAR_H + 8],
]);

benchPlate(s, PLATE);
// The console body.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CON_H, s.P, 6, 0.8));
// Smart bar: a raised rail with a recessed slot and the cursor block in it.
s.solid(slabOf(BAR, CON_H, BAR_H, s.P, 6, 0.6));
const barTop = CON_H + BAR_H;
const slot = insetPlan(BAR, 5);
s.line(planOutline(slot, barTop, s.P, 4), { tone: "mid" });
s.line(
	lineOnTop(
		[slot.x + 4, slot.y + slot.d / 2],
		[-28, slot.y + slot.d / 2],
		barTop,
		s.P
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: -26, y: slot.y + 1, w: 8, d: slot.d - 2, r: 1 },
		barTop,
		6,
		s.P,
		2
	),
	{
		lit: true,
	}
);
s.solid(cylinder(BAR.x + BAR.w - 9, BAR.y + BAR.d / 2, 4, barTop, 2, s.P, 24), {
	tone: "lo",
});
// Recent chats: a shallow tray with three cards, fanned forward.
const tray = { x: -80, y: -10, w: 92, d: 46, r: 3 };
s.solid(slabOf(tray, CON_H, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	const card = { x: -74 + i * 6, y: -6 + i * 10, w: 74, d: 16, r: 1.5 };
	const z = CON_H + 4 + i * 1.4;
	s.solid(slabOf(card, z, 1.4, s.P, 3), { crease: "none" });
	s.line(
		lineOnTop(
			[card.x + 5, card.y + 5],
			[card.x + 50 - i * 8, card.y + 5],
			z + 1.4,
			s.P
		),
		{ tone: "mid" }
	);
	s.line(
		lineOnTop(
			[card.x + 5, card.y + 10],
			[card.x + 36, card.y + 10],
			z + 1.4,
			s.P
		),
		{ tone: "faint" }
	);
}
faceRules(s, "y", CONSOLE.y + CONSOLE.d, CONSOLE.x + 8, 7, [26, 18], 3);
// Agent picker: a turntable of tokens and a fixed pointer post in front.
const [tx, ty] = TABLE;
s.halo(
	{
		x: tx - TABLE_R,
		y: ty - TABLE_R,
		w: TABLE_R * 2,
		d: TABLE_R * 2,
		r: TABLE_R,
	},
	0
);
s.solid(cylinder(tx, ty, TABLE_R, 0, 4, s.P, 56, 0.6), { tone: "lo" });
s.solid(cylinder(tx, ty, TABLE_R - 3, 4, 4, s.P, 56, 0.6));
s.line(ring(tx, ty, TABLE_R - 8, 8, s.P, 48), { tone: "faint" });
// The hub sits behind the near tokens, so it is drawn first.
s.solid(cylinder(tx, ty, 3.5, 8, 4, s.P, 20), { tone: "lo" });
const tokens: [number, number, number][] = [];
for (let i = 0; i < 6; i++) {
	const angle = (Math.PI * 2 * i) / 6 + Math.PI / 4;
	tokens.push([tx + Math.cos(angle) * 15, ty + Math.sin(angle) * 15, i]);
}
for (const [x, y, i] of byDepth(tokens, s, 8)) {
	const h = i === 0 ? 14 : 9;
	s.solid(cylinder(x, y, 4.2, 8, h, s.P, 24, 0.4));
	s.line(ring(x, y, 2, 8 + h, s.P, 16), { tone: "lo" });
}
// The pointer post the chosen agent is turned to.
s.solid(cylinder(tx + 22, ty + 22, 3, 0, 14, s.P, 20), { tone: "lo" });
s.solid(cylinder(tx + 22, ty + 22, 4, 14, 2, s.P, 20));
screws(s, [[CONSOLE.x + 108, CONSOLE.y + CONSOLE.d - 8]], CON_H, 1.4);

export const drawing = cardDrawing(s);
