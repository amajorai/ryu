import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Bilingual glossary extraction: a catalogue drawer. Past translations are
 * the bound volumes stacked behind; each term pair taken from them is two
 * index cards standing side by side on the drawer rod, source on the left,
 * target on the right. The newest pair rides up in its clip (the lit part).
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const DRAWER = { x: -30, y: -34, w: 104, d: 70, r: 4 };
const DRAWER_H = 14;
const CARD_H = 8;
const PAIRS = [-20, -8, 4, 16, 28, 40];
const NEWEST = 54;
// The bound volumes, bottom to top.
const VOLUMES = [
	{ x: -92, y: -38, w: 48, d: 62, r: 2 },
	{ x: -90, y: -34, w: 44, d: 56, r: 2 },
	{ x: -88, y: -36, w: 46, d: 58, r: 2 },
];
const VOLUME_H = 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[NEWEST, 0, DRAWER_H + CARD_H + 14],
	[-70, -10, VOLUME_H * 3],
]);

function card(x: number, y0: number, z: number, height: number) {
	s.solid(slabOf({ x, y: y0, w: 1.8, d: 24, r: 0.3 }, z, height, s.P, 2), {
		crease: "none",
	});
}

benchPlate(s, PLATE);
// Stack of past translations.
s.halo(VOLUMES[0] ?? DRAWER, 0);
VOLUMES.forEach((volume, index) => {
	const z = index * VOLUME_H;
	s.solid(slabOf(volume, z, VOLUME_H, s.P, 3, 0.6), {
		tone: index === 1 ? "lo" : "hi",
	});
	s.line(planOutline(insetPlan(volume, 4), z + VOLUME_H, s.P, 2), {
		tone: "faint",
	});
});
// The drawer, its rod and the card pairs.
s.halo(DRAWER, 0);
s.solid(slabOf(DRAWER, 0, DRAWER_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(DRAWER, 4), DRAWER_H, s.P, 3), { tone: "mid" });
s.line(
	lineOnTop([DRAWER.x + 6, 1], [DRAWER.x + DRAWER.w - 6, 1], DRAWER_H, s.P),
	{ tone: "faint" }
);
lamp(s, [DRAWER.x + 8, DRAWER.y + 8], DRAWER_H, { radius: 1.6 });
for (const x of PAIRS) {
	card(x, -28, DRAWER_H, CARD_H);
	card(x, 6, DRAWER_H, CARD_H);
}
// Newest pair, standing taller and joined by its clip.
const tall = CARD_H + 10;
card(NEWEST, -28, DRAWER_H, tall);
card(NEWEST, 6, DRAWER_H, tall);
s.solid(
	slabOf(
		{ x: NEWEST - 1, y: -28, w: 4, d: 58, r: 1 },
		DRAWER_H + tall,
		3,
		s.P,
		3
	),
	{ lit: true }
);
screws(
	s,
	[
		[DRAWER.x + DRAWER.w - 6, DRAWER.y + 6],
		[DRAWER.x + 6, DRAWER.y + DRAWER.d - 6],
	],
	DRAWER_H,
	1.2
);
// Drawer front: label frame and pull.
const front = DRAWER.y + DRAWER.d;
s.line(faceRect(s, "y", front, 12, 32, 5, 11), { tone: "lo" });
s.solid(slabOf({ x: 14, y: front, w: 16, d: 5, r: 2 }, 2, 3, s.P, 3), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
