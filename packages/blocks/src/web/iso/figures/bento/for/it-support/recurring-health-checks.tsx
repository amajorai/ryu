import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	radialTicks,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	jack,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Recurring health checks: a watch beacon on an interval clock, wired to a
 * ticket printer. The clock base turns the check over on schedule; when a
 * reading looks wrong the beacon lights (the lit lens) and the printer pushes
 * out a ticket.
 */

const PLATE = { x: -66, y: -52, w: 146, d: 98, r: 8 };
const TOWER: [number, number] = [-32, 12];
const BASE_R = 22;
const BASE_H = 8;
const COLUMN_H = 30;
const PRINTER = { x: 4, y: -42, w: 64, d: 46, r: 4 };
const PRINTER_H = 22;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TOWER[0], TOWER[1], 64],
]);

const [tx, ty] = TOWER;
benchPlate(s, PLATE);
// Interval clock: a turned base with an hour ring on top.
s.halo(
	{ x: tx - BASE_R, y: ty - BASE_R, w: 2 * BASE_R, d: 2 * BASE_R, r: BASE_R },
	0
);
s.solid(cylinder(tx, ty, BASE_R, 0, BASE_H, s.P, 48, 0.8));
const ticks = radialTicks(tx, ty, BASE_R - 2, 24, 6, BASE_H, [2.5, 5], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
// Column and beacon head.
s.solid(cylinder(tx, ty, 9, BASE_H, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(tx, ty, 4.5, BASE_H + 3, COLUMN_H, s.P, 24));
const head = BASE_H + 3 + COLUMN_H;
s.solid(cylinder(tx, ty, 10, head, 4, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(tx, ty, 8, head + 4, 10, s.P, 32), { lit: true });
s.solid(cylinder(tx, ty, 10, head + 14, 3, s.P, 32, 0.6));
s.solid(cylinder(tx, ty, 3, head + 17, 2, s.P, 16), { tone: "lo" });
// Ticket printer with a ticket coming out of its slot.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRINTER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(PRINTER, 4), PRINTER_H, s.P, 4), {
	tone: "faint",
});
const slot = { x: PRINTER.x + 12, y: PRINTER.y + 10, w: 36, d: 3, r: 1 };
s.line(planOutline(slot, PRINTER_H, s.P, 2), { tone: "mid" });
const ticket = { x: slot.x + 2, y: slot.y + 0.5, w: 32, d: 2, r: 0.4 };
s.solid(slabOf(ticket, PRINTER_H, 16, s.P, 2), { crease: "none" });
faceRules(
	s,
	"y",
	ticket.y + ticket.d,
	ticket.x + 4,
	PRINTER_H + 12,
	[22, 16, 18],
	3.5
);
knob(s, [PRINTER.x + 14, PRINTER.y + 32], PRINTER_H, 5, 4);
lamp(s, [PRINTER.x + 34, PRINTER.y + 32], PRINTER_H, { radius: 1.8 });
lamp(s, [PRINTER.x + 44, PRINTER.y + 32], PRINTER_H, { radius: 1.8 });
jack(s, [PRINTER.x + 54, PRINTER.y + 32], PRINTER_H);
screws(
	s,
	[
		[PRINTER.x + 6, PRINTER.y + 6],
		[PRINTER.x + PRINTER.w - 6, PRINTER.y + 6],
	],
	PRINTER_H,
	1.4
);
// Cable from the clock's side across the plate into the printer's front.
s.wire(
	[tx + 21.5, ty - 4, 2],
	[PRINTER.x + 10, PRINTER.y + PRINTER.d, 5],
	[
		[tx + 30, ty - 4, 0],
		[PRINTER.x + 10, ty - 4, 0],
	],
	{ tone: "mid" }
);
s.line(knurl(tx, ty, BASE_R, 1, BASE_H - 1, 48, s.P), { tone: "faint" });

export const drawing = cardDrawing(s);
