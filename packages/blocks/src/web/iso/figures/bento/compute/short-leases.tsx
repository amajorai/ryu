import { boxCorners, cylinder, ring, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Short leases: a rack of three hourglasses, small, medium and tall, one per
 * lease length. A selector slides along the groove in front and sits under
 * the one that is running (the lit carriage): every run is timed and ends.
 */

const PLATE = { x: -92, y: -48, w: 184, d: 96, r: 8 };
const RAIL = { x: -78, y: -24, w: 156, d: 50, r: 4 };
const RAIL_H = 6;
const ROW_Y = -8;
const GROOVE_Y = 16;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[48, ROW_Y, RAIL_H + 62],
]);

function hourglass(cx: number, height: number) {
	const cy = ROW_Y;
	const base = RAIL_H;
	const bulb = (height - 10) / 2;
	const top = base + height - 3;
	s.halo({ x: cx - 13, y: cy - 13, w: 26, d: 26, r: 13 }, base);
	s.solid(cylinder(cx, cy, 13, base, 3, s.P, 40, 0.4), { tone: "lo" });
	// Back post, then the glass, then the two side posts.
	s.solid(cylinder(cx - 8, cy - 8, 1.5, base + 3, height - 6, s.P, 12));
	const z = base + 3;
	s.solid(cylinder(cx, cy, 8, z, bulb * 0.5, s.P, 32), { tone: "lo" });
	s.solid(cylinder(cx, cy, 5.5, z + bulb * 0.5, bulb * 0.3, s.P, 28), {
		tone: "lo",
	});
	s.solid(cylinder(cx, cy, 3, z + bulb * 0.8, bulb * 0.2, s.P, 24), {
		tone: "lo",
	});
	s.solid(cylinder(cx, cy, 1.6, z + bulb, 4, s.P, 16), { tone: "lo" });
	s.solid(cylinder(cx, cy, 3, z + bulb + 4, bulb * 0.2, s.P, 24), {
		tone: "lo",
	});
	s.solid(cylinder(cx, cy, 5.5, z + bulb * 1.2 + 4, bulb * 0.3, s.P, 28), {
		tone: "lo",
	});
	s.solid(cylinder(cx, cy, 8, z + bulb * 1.5 + 4, bulb * 0.5, s.P, 32), {
		tone: "lo",
	});
	s.solid(cylinder(cx + 8, cy - 8, 1.5, base + 3, height - 6, s.P, 12));
	s.solid(cylinder(cx - 8, cy + 8, 1.5, base + 3, height - 6, s.P, 12));
	s.solid(cylinder(cx, cy, 13, top, 3, s.P, 40, 0.4));
	s.line(ring(cx, cy, 9, top + 3, s.P, 32), { tone: "faint" });
}

benchPlate(s, PLATE);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
hourglass(-48, 26);
hourglass(0, 42);
hourglass(48, 60);
// The selector groove with a detent under each glass.
const groove = { x: -66, y: GROOVE_Y - 2, w: 132, d: 4, r: 2 };
s.solid(slabOf(groove, RAIL_H - 1, 1, s.P, 4), {
	tone: "lo",
	crease: "none",
});
screws(
	s,
	[
		[-48, GROOVE_Y],
		[48, GROOVE_Y],
	],
	RAIL_H,
	1.4
);
const carriage = { x: -8, y: GROOVE_Y - 5, w: 16, d: 10, r: 2 };
s.halo(carriage, RAIL_H);
s.solid(slabOf(carriage, RAIL_H, 6, s.P, 4, 0.6), { lit: true });

export const drawing = cardDrawing(s);
