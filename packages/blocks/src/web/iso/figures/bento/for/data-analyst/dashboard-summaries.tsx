import {
	boxCorners,
	cylinder,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Dashboard summaries: an instrument console with three gauges, and the
 * tape printer beside it that reads them. The week's summary comes out of
 * its slot as a printed strip lying on the bench (the lit tape).
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const CONSOLE = { x: -82, y: -42, w: 104, d: 52, r: 4 };
const CONSOLE_H = 24;
const PRINTER = { x: 36, y: -38, w: 44, d: 36, r: 4 };
const PRINTER_H = 16;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(CONSOLE, 0, CONSOLE_H + 4),
]);

function gauge(x: number, y: number, angle: number) {
	const z = CONSOLE_H;
	s.solid(cylinder(x, y, 13, z, 2, s.P, 40, 0.4), { tone: "lo" });
	s.line(ring(x, y, 10.5, z + 2, s.P, 40), { tone: "faint" });
	const ticks = radialTicks(x, y, 10, 12, 3, z + 2, [2, 3.5], s.P, -2.2, 4.4);
	s.line(ticks.minor, { tone: "lo" });
	s.line(ticks.major, { tone: "mid" });
	const tip: [number, number] = [
		x + Math.sin(angle) * 8,
		y - Math.cos(angle) * 8,
	];
	s.line(lineOnTop([x, y], tip, z + 2.4, s.P), { tone: "hi" });
	s.solid(cylinder(x, y, 1.6, z + 2, 1.4, s.P, 16));
}

benchPlate(s, PLATE);
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 0.8));
gauge(-62, -20, -0.9);
gauge(-32, -20, 0.4);
gauge(-2, -20, 1.4);
knob(s, [-62, 2], CONSOLE_H, 3.5, 4);
knob(s, [-46, 2], CONSOLE_H, 3.5, 4);
lamp(s, [12, 2], CONSOLE_H, { radius: 1.8 });
s.line(
	faceRect(s, "y", CONSOLE.y + CONSOLE.d, CONSOLE.x + 8, CONSOLE.x + 40, 6, 16),
	{ tone: "lo" }
);
// The tape printer, slot low on its front face.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRINTER_H, s.P, 5, 0.8));
s.solid(cylinder(58, -20, 9, PRINTER_H, 4, s.P, 32, 0.4), { tone: "lo" });
s.line(ring(58, -20, 3, PRINTER_H + 4, s.P, 20), { tone: "mid" });
screws(s, [[PRINTER.x + 6, PRINTER.y + 6]], PRINTER_H, 1.4);
const front = PRINTER.y + PRINTER.d;
s.line(faceRect(s, "y", front, 44, 72, 0.8, 3), { tone: "mid" });
// The printed strip running out across the bench.
const tape = { x: 46, y: front, w: 24, d: 48, r: 1 };
s.solid(slabOf(tape, 0, 0.8, s.P, 2), { lit: true, crease: "none" });
[16, 11, 14, 8, 12].forEach((length, i) => {
	const y = tape.y + 8 + i * 7;
	s.line(lineOnTop([tape.x + 4, y], [tape.x + 4 + length, y], 0.8, s.P), {
		tone: "lo",
	});
});

export const drawing = cardDrawing(s);
