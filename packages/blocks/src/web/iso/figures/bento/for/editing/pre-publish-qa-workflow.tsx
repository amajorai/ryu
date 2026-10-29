import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	jack,
	knob,
	lamp,
	ruler,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Pre-publish QA workflow: a short line of three stations along a rail
 * (proofread, style, links), each with its own tool head. The piece passes
 * all three into one printer, which feeds out a single issue list (the lit
 * slip) before it goes live.
 */

const PLATE = { x: -102, y: -50, w: 204, d: 100, r: 8 };
const RAIL = { x: -90, y: -2, w: 132, d: 16, r: 3 };
const RAIL_H = 5;
const STATION_H = 26;
const PRINTER = { x: 40, y: -30, w: 46, d: 52, r: 4 };
const PRINTER_H = 26;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [60, -10, 52]]);

function station(x: number): {
	x: number;
	y: number;
	w: number;
	d: number;
	r: number;
} {
	const plan = { x: x - 9, y: -30, w: 18, d: 18, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, STATION_H, s.P, 4, 0.8));
	lamp(s, [x + 5, -16], STATION_H, { radius: 1.4 });
	return plan;
}

benchPlate(s, PLATE);
const proof = station(-66);
knob(s, [proof.x + 8, proof.y + 8], STATION_H, 4, 5);
const style = station(-34);
ruler(s, { x: style.x + 2, y: style.y + 3, w: 14, d: 5, r: 1 }, STATION_H);
const links = station(-2);
jack(s, [links.x + 8, links.y + 8], STATION_H);
// The rail and the piece riding it between stations.
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
s.solid(cylinder(RAIL.x + 7, RAIL.y + 8, 3, RAIL_H, 2, s.P, 20), {
	tone: "lo",
});
const piece = { x: -58, y: RAIL.y + 2, w: 20, d: 12, r: 2 };
s.halo(piece, RAIL_H);
s.solid(slabOf(piece, RAIL_H, 10, s.P, 3, 0.5));

// Printer at the end of the line, feeding out the issue list.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRINTER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(PRINTER, 4), PRINTER_H, s.P, 4), {
	tone: "faint",
});
const slot = { x: PRINTER.x + 10, y: PRINTER.y + 12, w: 26, d: 3, r: 1 };
s.line(planOutline(slot, PRINTER_H, s.P, 2), { tone: "mid" });
const slip = { x: slot.x + 2, y: slot.y + 0.8, w: 22, d: 1.4, r: 0.3 };
s.solid(slabOf(slip, PRINTER_H, 22, s.P, 2), { lit: true, crease: "none" });
faceRules(s, "y", slip.y + slip.d, slip.x + 3, PRINTER_H + 18, [14, 10, 12], 4);
screws(
	s,
	[
		[PRINTER.x + 8, PRINTER.y + PRINTER.d - 8],
		[PRINTER.x + PRINTER.w - 8, PRINTER.y + PRINTER.d - 8],
	],
	PRINTER_H,
	1.4
);
export const drawing = cardDrawing(s);
