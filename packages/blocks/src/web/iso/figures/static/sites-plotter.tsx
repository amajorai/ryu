import {
	boxCorners,
	cylinder,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { knob, lamp, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Sites: a site laid out, reviewed and shipped. A flatbed plotter drawing
 * a page layout: a gantry bridge rides two rails over the sheet, its pen
 * carriage (the lit part) at work, the finished blocks already on the page.
 */

const WIDTH = 640;
const HEIGHT = 420;
const BED = { x: -130, y: -80, w: 250, d: 150, r: 6 };
const BED_H = 12;
const SHEET = { x: -96, y: -60, w: 160, d: 110, r: 1 };
const RAIL_Y = [BED.y + 6, BED.y + BED.d - 12];
const BRIDGE_X = 30;
const CARRIAGE_Y = -2;
const BRIDGE_Z = BED_H + 22;

const s = createSketch(
	[...boxCorners(BED, -6, 0), [BRIDGE_X, 0, BRIDGE_Z + 20]],
	WIDTH,
	HEIGHT
);
const top = BED_H + 0.6;

function bed() {
	s.halo(BED, -6, 8);
	s.solid(slabOf(BED, -6, BED_H + 6, s.P, 6, 1.2));
	screws(
		s,
		[
			[BED.x + 8, BED.y + 30],
			[BED.x + 8, BED.y + BED.d - 30],
		],
		BED_H,
		1.3
	);
	for (const y of RAIL_Y) {
		s.solid(
			slabOf(
				{ x: BED.x + 4, y, w: BED.w - 8, d: 6, r: 1 },
				BED_H,
				3,
				s.P,
				3,
				0.4
			)
		);
	}
	knob(s, [BED.x + BED.w - 12, BED.y + BED.d - 4], BED_H, 3.4, 4);
	lamp(s, [BED.x + BED.w - 12, BED.y + 26], BED_H, { lit: true });
}

function sheet() {
	s.solid(slabOf(SHEET, BED_H, 0.6, s.P, 2), { tone: "lo", crease: "none" });
	// The layout drawn so far: header bar, hero block, three cards, text rules.
	const blocks = [
		{ x: SHEET.x + 8, y: SHEET.y + 8, w: SHEET.w - 16, d: 8, r: 0.5 },
		{ x: SHEET.x + 8, y: SHEET.y + 22, w: 86, d: 34, r: 0.5 },
		{ x: SHEET.x + 8, y: SHEET.y + 64, w: 40, d: 28, r: 0.5 },
		{ x: SHEET.x + 56, y: SHEET.y + 64, w: 40, d: 28, r: 0.5 },
	];
	for (const block of blocks) {
		s.line(planOutline(block, top, s.P, 2), { tone: "mid" });
	}
	for (let i = 0; i < 4; i++) {
		s.line(
			lineOnTop(
				[SHEET.x + 102, SHEET.y + 26 + i * 6],
				[SHEET.x + 102 + (i % 2 ? 34 : 46), SHEET.y + 26 + i * 6],
				top,
				s.P
			),
			{
				tone: "faint",
				free: true,
			}
		);
	}
	// The card the pen is drawing now, dotted where it has not reached yet.
	s.line(
		planOutline(
			{ x: SHEET.x + 104, y: SHEET.y + 64, w: 40, d: 28, r: 0.5 },
			top,
			s.P,
			2
		),
		{ tone: "lo", dotted: true }
	);
}

function gantry() {
	for (const y of RAIL_Y) {
		s.solid(
			slabOf(
				{ x: BRIDGE_X - 8, y: y - 2, w: 16, d: 10, r: 1.5 },
				BED_H + 3,
				BRIDGE_Z - BED_H - 3,
				s.P,
				3,
				0.5
			)
		);
	}
	s.solid(
		slabOf(
			{
				x: BRIDGE_X - 5,
				y: RAIL_Y[0] ?? 0,
				w: 10,
				d: (RAIL_Y[1] ?? 0) - (RAIL_Y[0] ?? 0) + 6,
				r: 1.5,
			},
			BRIDGE_Z,
			8,
			s.P,
			3,
			0.5
		)
	);
	// The pen carriage hangs from the bridge over the sheet.
	const carriage = { x: BRIDGE_X - 9, y: CARRIAGE_Y - 8, w: 18, d: 16, r: 2 };
	s.solid(slabOf(carriage, BRIDGE_Z - 6, 18, s.P, 4, 0.6), { lit: true });
	s.solid(
		cylinder(
			BRIDGE_X + 4,
			CARRIAGE_Y + 4,
			1.8,
			top,
			BRIDGE_Z - 6 - top,
			s.P,
			14
		),
		{ lit: true, crease: "none" }
	);
}

bed();
sheet();
gantry();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
