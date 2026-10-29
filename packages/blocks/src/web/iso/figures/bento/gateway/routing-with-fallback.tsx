import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Routing with fallback: a track switch. Calls come in on one rail; the
 * points are thrown away from the first provider, whose five failure lamps
 * are all on, and onto the fallback, which takes the call (the lit block).
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const RAIL_H = 4;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [70, -30, 30]]);

function rail(
	from: [number, number],
	to: [number, number],
	tone: "mid" | "faint"
) {
	s.line(lineOnTop([from[0], from[1] - 4], [to[0], to[1] - 4], RAIL_H, s.P), {
		tone,
	});
	s.line(lineOnTop([from[0], from[1] + 4], [to[0], to[1] + 4], RAIL_H, s.P), {
		tone,
	});
}

function provider(y: number, failures: number) {
	const plan = { x: 46, y: y - 16, w: 40, d: 32, r: 4 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 22, s.P, 6, 0.8));
	for (let i = 0; i < 5; i++) {
		lamp(s, [plan.x + 8 + i * 6, plan.y + 6], 22, {
			lit: i < failures,
			radius: 1.6,
		});
	}
}

benchPlate(s, PLATE);
s.solid(
	slabOf({ x: -90, y: -40, w: 136, d: 80, r: 4 }, 0, RAIL_H, s.P, 4, 0.6),
	{
		tone: "lo",
	}
);
provider(-26, 5);
rail([-84, 0], [-20, 0], "mid");
rail([-20, 0], [46, -26], "faint");
rail([-20, 0], [46, 26], "mid");
knob(s, [-28, -26], RAIL_H, 5, 6);
s.solid(cylinder(-20, 0, 4, RAIL_H, 2, s.P, 24), { tone: "lo" });
const call = { x: 14, y: 6, w: 22, d: 16, r: 2 };
s.halo(call, RAIL_H);
s.solid(slabOf(call, RAIL_H, 12, s.P, 4, 0.6), { lit: true });
provider(26, 0);

export const drawing = cardDrawing(s);
