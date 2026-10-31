import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	planOutline,
	radialTicks,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Switch any time: a rotary selector. A ring of detent positions runs round a
 * big knurled dial, one lamp per interface; the pointer has clicked onto the
 * lit one, and the shortcut's three keys sit on the front ledge.
 */

const PLATE = { x: -88, y: -54, w: 176, d: 108, r: 8 };
const DECK = { x: -62, y: -44, w: 124, d: 66, r: 6 };
const DECK_H = 10;
const DIAL: [number, number] = [-12, -12];
const DIAL_R = 17;
const POSITIONS = 9;
const LIT = 6;
const KEYS = [24, 38, 52];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, DECK_H + 16]]);

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1));
s.line(
	planOutline(
		{
			...DECK,
			x: DECK.x + 5,
			y: DECK.y + 5,
			w: DECK.w - 10,
			d: DECK.d - 10,
			r: 3,
		},
		DECK_H,
		s.P,
		4
	),
	{ tone: "faint" }
);
screws(
	s,
	[
		[DECK.x + 7, DECK.y + 7],
		[DECK.x + DECK.w - 7, DECK.y + 7],
	],
	DECK_H,
	1.3
);

// The detent ring: one lamp per position round the dial.
const ringR = DIAL_R + 9;
const from = Math.PI * 0.85;
const span = Math.PI * 1.3;
const spots: [number, number, boolean][] = [];
for (let index = 0; index < POSITIONS; index++) {
	const angle = from + (span * index) / (POSITIONS - 1);
	spots.push([
		DIAL[0] + Math.cos(angle) * ringR,
		DIAL[1] + Math.sin(angle) * ringR,
		index === LIT,
	]);
}
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	DIAL_R + 3,
	36,
	4,
	DECK_H,
	[1.4, 2.6],
	s.P,
	from,
	span
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
for (const [x, y, lit] of byDepth(spots, s, DECK_H)) {
	lamp(s, [x, y], DECK_H, { lit, radius: 1.8 });
}

// The dial: a collar, a knurled skirt and a cap whose pointer sits on the lit position.
const top = DECK_H + 12;
s.solid(cylinder(DIAL[0], DIAL[1], DIAL_R + 2, DECK_H, 1.4, s.P, 40), {
	tone: "lo",
});
s.solid(cylinder(DIAL[0], DIAL[1], DIAL_R, DECK_H + 1.4, 8, s.P, 48));
s.line(knurl(DIAL[0], DIAL[1], DIAL_R, DECK_H + 1.4, DECK_H + 9.4, 48, s.P), {
	tone: "lo",
});
s.solid(
	cylinder(
		DIAL[0],
		DIAL[1],
		DIAL_R - 4,
		DECK_H + 9.4,
		top - DECK_H - 9.4,
		s.P,
		40,
		0.8
	)
);
const litAngle = from + (span * LIT) / (POSITIONS - 1);
s.line(
	lineOnTop(
		DIAL,
		[
			DIAL[0] + Math.cos(litAngle) * (DIAL_R - 6),
			DIAL[1] + Math.sin(litAngle) * (DIAL_R - 6),
		],
		top,
		s.P
	),
	{ tone: "hi" }
);

// Three keycaps on the front-right: the shortcut that always switches.
for (const x of KEYS) {
	const key = { x: x - 6, y: 2, w: 12, d: 12, r: 2.5 };
	s.solid(slabOf(key, DECK_H, 2, s.P, 4, 0.4), { tone: "lo" });
	s.solid(
		slabOf(
			{ ...key, x: key.x + 1.2, y: key.y + 1.2, w: 9.6, d: 9.6, r: 2 },
			DECK_H + 2,
			3,
			s.P,
			4,
			0.6
		)
	);
}

export const drawing = cardDrawing(s);
