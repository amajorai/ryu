import {
	boxCorners,
	cylinder,
	depthOf,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * One post, many formats: a turntable press. The one post sits on the
 * centre pedestal (the lit block); around the turntable each station has
 * stamped it into a different shape: a thread of tiles, a square post, three
 * ad cards, and a flat envelope.
 */

const PLATE = { x: -70, y: -70, w: 140, d: 140, r: 10 };
const R = 58;
const TABLE_H = 6;
const PED_H = 18;

type Piece = [number, number, "thread" | "square" | "ads" | "email"];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, PED_H + 12]]);

const polar = (angle: number, radius: number): [number, number] => [
	Math.cos(angle) * radius,
	Math.sin(angle) * radius,
];

function piece([x, y, kind]: Piece) {
	const z = TABLE_H;
	if (kind === "thread") {
		for (const dy of [-12, 0, 12]) {
			s.solid(
				slabOf(
					{ x: x - 5, y: y + dy - 5, w: 10, d: 10, r: 1 },
					z,
					5,
					s.P,
					2,
					0.3
				)
			);
		}
	} else if (kind === "square") {
		s.solid(
			slabOf({ x: x - 10, y: y - 10, w: 20, d: 20, r: 1.5 }, z, 4, s.P, 2, 0.3)
		);
		s.line(lineOnTop([x - 6, y - 4], [x + 6, y - 4], z + 4, s.P), {
			tone: "lo",
		});
		s.line(lineOnTop([x - 6, y + 2], [x + 2, y + 2], z + 4, s.P), {
			tone: "lo",
		});
	} else if (kind === "ads") {
		for (const dx of [-8, 0, 8]) {
			s.solid(
				slabOf(
					{ x: x + dx - 1, y: y - 8, w: 2.4, d: 16, r: 0.3 },
					z,
					14,
					s.P,
					2
				),
				{ crease: "none" }
			);
		}
	} else {
		s.solid(slabOf({ x: x - 12, y: y - 8, w: 24, d: 16, r: 1 }, z, 3, s.P, 2));
		s.line(lineOnTop([x - 11, y - 7], [x, y + 2], z + 3, s.P), { tone: "lo" });
		s.line(lineOnTop([x, y + 2], [x + 11, y - 7], z + 3, s.P), { tone: "lo" });
	}
}

benchPlate(s, PLATE);
s.halo({ x: -R, y: -R, w: 2 * R, d: 2 * R, r: R }, 0);
s.solid(cylinder(0, 0, R + 2, 0, 2, s.P, 64), { tone: "lo" });
s.solid(cylinder(0, 0, R, 2, TABLE_H - 2, s.P, 64, 0.6));
s.line(ring(0, 0, R - 5, TABLE_H, s.P, 64), { tone: "faint" });
s.line(ring(0, 0, 22, TABLE_H, s.P, 48), { tone: "faint" });
const pieces: Piece[] = [
	[...polar(Math.PI, 38), "email"],
	[...polar(Math.PI / 2, 38), "thread"],
	[...polar(-Math.PI / 2, 38), "square"],
	[...polar(0, 38), "ads"],
];
const sorted = byDepth(pieces, s, TABLE_H);
const behind = (p: Piece) => depthOf([p[0], p[1], 0], s.P) < 0;
for (const p of sorted.filter(behind)) {
	piece(p);
}
// Centre pedestal holding the one post.
s.solid(cylinder(0, 0, 12, TABLE_H, 2, s.P, 32), { tone: "lo" });
s.solid(cylinder(0, 0, 9, TABLE_H + 2, PED_H - TABLE_H - 2, s.P, 32, 0.6));
s.solid(slabOf({ x: -9, y: -7, w: 18, d: 14, r: 2 }, PED_H, 7, s.P, 3, 0.6), {
	lit: true,
});
for (const p of sorted.filter((p) => !behind(p))) {
	piece(p);
}
lamp(s, [PLATE.x + 12, PLATE.y + PLATE.d - 12], 0, { radius: 2 });

export const drawing = cardDrawing(s);
