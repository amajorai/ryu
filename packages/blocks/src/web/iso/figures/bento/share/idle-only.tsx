import {
	boxCorners,
	cylinder,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceLine, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Idle only: a tower workstation with a job slot on top. The keyboard and
 * mouse sit untouched; while nobody uses the machine its idle lamp (the lit
 * part) glows and the slot takes the job cartridge half way in.
 */

const PLATE = { x: -90, y: -54, w: 150, d: 108, r: 8 };
const TOWER = { x: -72, y: -42, w: 50, d: 80, r: 4 };
const TOWER_H = 54;
const FRONT = TOWER.x + TOWER.w;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-48, -20, 82]]);

benchPlate(s, PLATE);
s.halo(TOWER, 0);
s.solid(slabOf(TOWER, 0, TOWER_H, s.P, 4, 1));
// Vent slats and a drive bay on the front (+x) face.
for (let z = 10; z <= 30; z += 4) {
	s.line(faceLine(s, "x", FRONT, -34, -6, z), {
		tone: "lo",
	});
}
s.line(
	[faceLine(s, "x", FRONT, 6, 30, 44), faceLine(s, "x", FRONT, 6, 30, 38)].join(
		""
	),
	{ tone: "mid" }
);
// The job slot on top, with a cartridge half way in.
const slot = { x: -54, y: -30, w: 14, d: 22, r: 1.5 };
s.line(planOutline(slot, TOWER_H, s.P, 3), { tone: "mid" });
s.solid(slabOf({ x: -51, y: -28, w: 8, d: 18, r: 1 }, TOWER_H, 24, s.P, 3));
s.solid(
	slabOf({ x: -52, y: -29, w: 10, d: 20, r: 1.5 }, TOWER_H + 24, 4, s.P, 3),
	{
		tone: "lo",
	}
);
// Power button and the idle lamp near the front-top edge.
s.solid(cylinder(-30, 20, 4, TOWER_H, 1.6, s.P, 24), { tone: "lo" });
lamp(s, [-30, 30], TOWER_H, { lit: true, radius: 2.6 });
screws(s, [[-64, 28]], TOWER_H, 1.4);

// Keyboard lying idle in front of the tower.
const KEYBOARD = { x: 4, y: -46, w: 30, d: 68, r: 3 };
s.halo(KEYBOARD, 0);
s.solid(slabOf(KEYBOARD, 0, 4, s.P, 4, 0.6));
const keys: string[] = [];
for (let row = 0; row < 3; row++) {
	for (let col = 0; col < 9; col++) {
		keys.push(
			planOutline(
				{ x: 7 + row * 6.5, y: -42 + col * 6.8, w: 5.4, d: 5, r: 1 },
				4,
				s.P,
				2
			)
		);
	}
}
// Space bar on the near row.
keys.push(planOutline({ x: 26.5, y: -24, w: 5, d: 22, r: 1 }, 4, s.P, 2));
s.line(keys.join(""), { tone: "lo" });
// Mouse on its pad, beside the keyboard.
const PAD = { x: 10, y: 26, w: 34, d: 24, r: 4 };
s.solid(slabOf(PAD, 0, 1.2, s.P, 4), { tone: "lo" });
const MOUSE = { x: 18, y: 30, w: 20, d: 15, r: 6 };
s.halo(MOUSE, 1.2);
s.solid(slabOf(MOUSE, 1.2, 6, s.P, 8, 1.6));
s.line(faceLine(s, "y", 37.5, 18, 26, 7.2), { tone: "faint" });

export const drawing = cardDrawing(s);
