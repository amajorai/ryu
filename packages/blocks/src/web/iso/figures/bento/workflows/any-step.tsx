import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Any step: a rail of identical sockets. Every cartridge has the same foot,
 * so any of them clicks into any slot: an agent (a box with a dial), a tool
 * (a spindle), a skill (a cassette of plates), or a whole workflow, which is
 * itself a tiny rail of slots (the lit cartridge on its mini rail).
 */

const PLATE = { x: -100, y: -36, w: 200, d: 72, r: 8 };
const RAIL = { x: -90, y: -18, w: 180, d: 36, r: 3 };
const RAIL_H = 6;
const SLOTS = [-66, -22, 22, 66] as const;
const FOOT_H = 5;
const TOP = RAIL_H + FOOT_H;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-66, 0, 46]]);

function foot(cx: number) {
	const plan = { x: cx - 16, y: -13, w: 32, d: 26, r: 2 };
	s.solid(slabOf(plan, RAIL_H, FOOT_H, s.P, 4, 0.6), { tone: "lo" });
	return plan;
}

function agent(cx: number) {
	const body = { x: cx - 13, y: -11, w: 26, d: 22, r: 3 };
	foot(cx);
	s.solid(slabOf(body, TOP, 22, s.P, 6, 0.8));
	const z = TOP + 22;
	s.solid(cylinder(cx - 2, 0, 7, z, 3, s.P, 32), { tone: "lo" });
	s.line(knurl(cx - 2, 0, 7, z, z + 3, 28, s.P), { tone: "lo" });
	s.line(lineOnTop([cx - 2, 0], [cx + 3, 0], z + 3, s.P), { tone: "hi" });
	lamp(s, [cx + 8, -6], z, { radius: 1.4 });
}

function tool(cx: number) {
	foot(cx);
	s.solid(cylinder(cx, 0, 10, TOP, 6, s.P, 32, 0.6));
	s.solid(cylinder(cx, 0, 6, TOP + 6, 12, s.P, 28), { tone: "lo" });
	s.solid(cylinder(cx, 0, 3.4, TOP + 18, 10, s.P, 24));
	s.line(ring(cx, 0, 1.4, TOP + 28, s.P, 16), { tone: "mid" });
}

function skill(cx: number) {
	foot(cx);
	for (let i = 0; i < 4; i++) {
		s.solid(
			slabOf(
				{ x: cx - 12, y: -10, w: 24, d: 20, r: 2 },
				TOP + i * 5,
				4,
				s.P,
				4
			),
			{ tone: i % 2 ? "lo" : "mid" }
		);
	}
	s.solid(
		slabOf({ x: cx - 4, y: 10, w: 8, d: 2, r: 0.5 }, TOP + 8, 3, s.P, 2),
		{
			tone: "lo",
		}
	);
}

function workflow(cx: number) {
	const body = { x: cx - 14, y: -12, w: 28, d: 24, r: 3 };
	foot(cx);
	s.solid(slabOf(body, TOP, 8, s.P, 6, 0.8));
	// On top, a miniature of the main rail: three tiny cartridges in a row,
	// so a workflow step is itself a chain of steps.
	const z = TOP + 8;
	const mini = { x: cx - 11, y: -5, w: 22, d: 10, r: 1.5 };
	s.solid(slabOf(mini, z, 2, s.P, 3), { tone: "lo" });
	s.solid(
		slabOf({ x: cx - 9.5, y: -3.5, w: 6, d: 7, r: 1 }, z + 2, 6, s.P, 3),
		{ tone: "mid" }
	);
	s.solid(cylinder(cx, 0, 3, z + 2, 8, s.P, 24), { tone: "lo" });
	s.solid(
		slabOf({ x: cx + 3.5, y: -3.5, w: 6, d: 7, r: 1 }, z + 2, 6, s.P, 3),
		{ lit: true }
	);
	lamp(s, [cx - 8, 9], z, { radius: 1.3 });
	lamp(s, [cx + 8, 9], z, { radius: 1.3 });
}

benchPlate(s, PLATE);
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.8), { tone: "lo" });
for (const cx of SLOTS) {
	s.line(
		planOutline({ x: cx - 18, y: -15, w: 36, d: 30, r: 2 }, RAIL_H, s.P, 3),
		{
			tone: "faint",
		}
	);
}
screws(
	s,
	[
		[RAIL.x + 5, 0],
		[RAIL.x + RAIL.w - 5, 0],
	],
	RAIL_H,
	1.4
);
agent(SLOTS[0]);
tool(SLOTS[1]);
skill(SLOTS[2]);
workflow(SLOTS[3]);

export const drawing = cardDrawing(s);
