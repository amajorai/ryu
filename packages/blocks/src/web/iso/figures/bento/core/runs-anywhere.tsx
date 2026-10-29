import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Runs anywhere: one cartridge, three hosts. The same module seats in a
 * laptop, a tower and a rack server; the one seated in the server
 * (the lit cartridge) is the Docker install.
 */

const PLATE = { x: -104, y: -54, w: 208, d: 108, r: 8 };
const TOWER = { x: -16, y: -30, w: 28, d: 44, r: 3 };
const TOWER_H = 50;
const RACK = { x: 30, y: -30, w: 60, d: 50, r: 3 };
const UNIT_H = 10;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, TOWER_H + 8]]);

function cartridge(x: number, y: number, z: number, lit = false) {
	const plan = { x: x - 7, y: y - 5, w: 14, d: 10, r: 1.5 };
	s.solid(slabOf(plan, z, 7, s.P, 3, 0.4), { lit });
}

function slot(x: number, y: number, z: number) {
	s.line(planOutline({ x: x - 8, y: y - 6, w: 16, d: 12, r: 2 }, z, s.P, 3), {
		tone: "lo",
	});
}

benchPlate(s, PLATE);
// Laptop: lid standing at the back, keyboard deck in front.
const deck = { x: -90, y: -22, w: 58, d: 40, r: 3 };
s.halo(deck, 0);
s.solid(
	slabOf(
		{ x: deck.x, y: deck.y - 4, w: deck.w, d: 4, r: 1 },
		0,
		34,
		s.P,
		2,
		0.4
	)
);
s.line(faceRect(s, "y", deck.y, deck.x + 4, deck.x + deck.w - 4, 8, 31), {
	tone: "faint",
});
s.solid(slabOf(deck, 0, 4, s.P, 4, 0.6));
s.line(planOutline({ x: -86, y: -18, w: 50, d: 18, r: 1 }, 4, s.P, 2), {
	tone: "faint",
});
s.line(planOutline({ x: -70, y: 4, w: 18, d: 10, r: 1 }, 4, s.P, 2), {
	tone: "faint",
});
slot(-61, -9, 4);
cartridge(-61, -9, 4);
// Tower: tall case with drive bays and a top-loading slot.
s.halo(TOWER, 0);
s.solid(slabOf(TOWER, 0, TOWER_H, s.P, 4, 0.8));
const front = TOWER.y + TOWER.d;
s.line(faceRect(s, "y", front, TOWER.x + 5, TOWER.x + TOWER.w - 5, 38, 44), {
	tone: "lo",
});
faceRules(s, "y", front, TOWER.x + 5, 30, [18, 18, 18], 4);
lamp(s, [TOWER.x + TOWER.w - 6, TOWER.y + TOWER.d - 6], TOWER_H, {
	radius: 1.6,
});
slot(-2, -12, TOWER_H);
cartridge(-2, -12, TOWER_H);
// Rack server: three stacked units, the cartridge seated in the top.
s.halo(RACK, 0);
for (let i = 0; i < 3; i++) {
	s.solid(slabOf(RACK, i * (UNIT_H + 1), UNIT_H, s.P, 4, 0.6));
	const z = i * (UNIT_H + 1);
	s.line(
		faceRect(s, "y", RACK.y + RACK.d, RACK.x + 6, RACK.x + 26, z + 3, z + 7),
		{ tone: "lo" }
	);
	lamp(s, [RACK.x + RACK.w - 6, RACK.y + RACK.d - 1], z + UNIT_H - 2, {
		radius: 1,
	});
}
const top = 3 * UNIT_H + 2;
s.line(planOutline(insetPlan(RACK, 5), top, s.P, 3), { tone: "faint" });
screws(
	s,
	[
		[RACK.x + 9, RACK.y + 9],
		[RACK.x + RACK.w - 9, RACK.y + 9],
	],
	top,
	1.4
);
slot(60, -4, top);
cartridge(60, -4, top, true);

export const drawing = cardDrawing(s);
