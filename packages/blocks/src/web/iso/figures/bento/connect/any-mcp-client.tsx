import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, jack, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Any MCP client: a round patch hub with jacks all around its top. Three
 * unlike devices (a laptop, a terminal box, a handset) are cabled into the
 * same hub; its centre lamp (the lit part) shows one endpoint serving them.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const HUB: [number, number] = [8, 0];
const HUB_R = 22;
const HUB_H = 16;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -30, 40]]);

const polar = (angle: number, radius: number): [number, number] => [
	HUB[0] + Math.cos(angle) * radius,
	HUB[1] + Math.sin(angle) * radius,
];
const JACK_R = HUB_R - 7;
const jacks = [
	polar(-2.4, JACK_R),
	polar(-1.2, JACK_R),
	polar(0.6, JACK_R),
	polar(1.9, JACK_R),
] as const;

benchPlate(s, PLATE);
// Cables run along the bench from each device to a jack on the hub.
s.wire([-62, -26, 2], [jacks[0][0], jacks[0][1], HUB_H], [[-40, -30, 1]]);
s.wire([60, -34, 14], [jacks[1][0], jacks[1][1], HUB_H], [[44, -28, 1]]);
s.wire([-56, 30, 4], [jacks[3][0], jacks[3][1], HUB_H], [[-30, 30, 1]]);
// Laptop at the back left: base and a raised lid.
const base = { x: -84, y: -42, w: 40, d: 28, r: 3 };
s.halo(base, 0);
s.solid(slabOf(base, 0, 4, s.P, 4, 0.4));
s.line(planOutline(insetPlan(base, 4), 4, s.P, 3), { tone: "faint" });
s.solid(slabOf({ x: -84, y: -46, w: 40, d: 3, r: 1 }, 0, 34, s.P, 2));
s.line(faceRect(s, "y", -43, -80, -48, 6, 30), { tone: "lo" });
// Terminal box at the back right.
const term = { x: 50, y: -46, w: 34, d: 24, r: 3 };
s.halo(term, 0);
s.solid(slabOf(term, 0, 22, s.P, 4, 0.6));
s.line(faceRect(s, "y", term.y + term.d, term.x + 5, term.x + 29, 7, 18), {
	tone: "lo",
});
// The hub.
s.halo(
	{ x: HUB[0] - HUB_R, y: -HUB_R, w: 2 * HUB_R, d: 2 * HUB_R, r: HUB_R },
	0
);
s.solid(cylinder(HUB[0], HUB[1], HUB_R + 3, 0, 3, s.P, 48), { tone: "lo" });
s.solid(cylinder(HUB[0], HUB[1], HUB_R, 3, HUB_H - 3, s.P, 48, 0.6));
s.line(knurl(HUB[0], HUB[1], HUB_R, 4, HUB_H - 1, 40, s.P), { tone: "faint" });
s.line(ring(HUB[0], HUB[1], HUB_R - 3, HUB_H, s.P, 48), { tone: "faint" });
for (const at of jacks) {
	jack(s, at, HUB_H);
}
lamp(s, HUB, HUB_H, { lit: true, radius: 4 });
// Handset at the front left, lying on its back.
const phone = { x: -76, y: 20, w: 20, d: 30, r: 4 };
s.halo(phone, 0);
s.solid(slabOf(phone, 0, 5, s.P, 6, 0.6));
s.line(planOutline(insetPlan(phone, 3), 5, s.P, 4), { tone: "lo" });

export const drawing = cardDrawing(s);
