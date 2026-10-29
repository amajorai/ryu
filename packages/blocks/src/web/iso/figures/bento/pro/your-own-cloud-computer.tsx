import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
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
 * Your own cloud computer: a tower case of your own on the bench, wired to an
 * uplink box with two aerials behind it, so it runs out there, not on your
 * desk. Its power button (the lit part) is on: the machine is yours and up.
 */

const PLATE = { x: -62, y: -50, w: 136, d: 86, r: 8 };
const TOWER = { x: -44, y: -36, w: 34, d: 62, r: 3 };
const TOWER_H = 66;
const UPLINK = { x: 18, y: -40, w: 44, d: 24, r: 3 };
const UPLINK_H = 10;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TOWER.x, TOWER.y, TOWER_H + 4],
	[UPLINK.x + 10, UPLINK.y + 6, UPLINK_H + 30],
]);

const front = TOWER.y + TOWER.d;
const side = TOWER.x + TOWER.w;

benchPlate(s, PLATE);
// Tower: plinth, case, top screws and a vent ring for the top fan.
s.halo(TOWER, 0, 6);
s.solid(slabOf(insetPlan(TOWER, -2), 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(TOWER, 4, TOWER_H - 4, s.P, 4, 1));
screws(s, corners(TOWER, 5), TOWER_H, 1.3);
s.line(planOutline(insetPlan(TOWER, 4), TOWER_H, s.P, 3), { tone: "faint" });
s.line(ring(TOWER.x + TOWER.w / 2, TOWER.y + 34, 10, TOWER_H, s.P, 32), {
	tone: "lo",
});
s.line(ring(TOWER.x + TOWER.w / 2, TOWER.y + 34, 3, TOWER_H, s.P, 16), {
	tone: "mid",
});
// Front bezel: two drive bays, a slot and a status strip.
s.line(faceRect(s, "y", front, TOWER.x + 4, side - 4, 8, TOWER_H - 6), {
	tone: "mid",
});
for (const z of [TOWER_H - 18, TOWER_H - 28]) {
	s.line(faceRect(s, "y", front, TOWER.x + 7, side - 7, z, z + 7), {
		tone: "lo",
	});
}
faceRules(s, "y", front, TOWER.x + 9, 22, [16, 12, 16], 4);
// Side panel: a vent grille.
const vents = [];
for (let row = 0; row < 6; row++) {
	for (let col = 0; col < 7; col++) {
		vents.push(s.at([side, TOWER.y + 14 + col * 6, 16 + row * 6]));
	}
}
s.dots(vents, { size: 0.55, tone: "lo" });
// Power button standing proud of the bezel: the lit part.
s.solid(
	slabOf(
		{ x: TOWER.x + 13, y: front, w: 8, d: 2.4, r: 1 },
		TOWER_H - 40,
		7,
		s.P,
		3
	),
	{ lit: true }
);
// Uplink box behind, with two aerials and a link lamp, wired to the tower.
s.halo(UPLINK, 0);
s.solid(slabOf(UPLINK, 0, UPLINK_H, s.P, 4, 0.6));
for (const x of [UPLINK.x + 8, UPLINK.x + UPLINK.w - 8]) {
	s.solid(cylinder(x, UPLINK.y + 7, 2.6, UPLINK_H, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, UPLINK.y + 7, 1.2, UPLINK_H + 2, 26, s.P, 12));
}
lamp(s, [UPLINK.x + 22, UPLINK.y + 14], UPLINK_H, { radius: 1.6 });
lamp(s, [UPLINK.x + 30, UPLINK.y + 14], UPLINK_H, { radius: 1.6 });
s.wire(
	[UPLINK.x, UPLINK.y + 18, 4],
	[side, TOWER.y + 8, 6],
	[[UPLINK.x - 10, UPLINK.y + 20, 0]]
);

export const drawing = cardDrawing(s);
