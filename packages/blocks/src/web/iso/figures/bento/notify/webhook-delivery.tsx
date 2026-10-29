import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	jack,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Webhook delivery: a pneumatic tube station. A sealed carrier waits in the
 * send cup at the front; its wax seal (the lit disc) is the signature, and the
 * tube rising out of the cabinet carries it to the endpoint. Spare outlets
 * stand for the other HTTP channels.
 */

const PLATE = { x: -84, y: -52, w: 168, d: 104, r: 8 };
const CABINET = { x: -50, y: -38, w: 64, d: 50, r: 5 };
const CAB_H = 34;
const TUBE: [number, number] = [-18, -14];
const TUBE_TOP = 78;
const CUP: [number, number] = [-18, 30];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TUBE[0], TUBE[1], TUBE_TOP + 4],
]);

benchPlate(s, PLATE);
s.halo(CABINET, 0);
s.solid(slabOf(CABINET, 0, CAB_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CABINET, 4), CAB_H, s.P, 4), { tone: "faint" });
s.line(
	faceRect(
		s,
		"y",
		CABINET.y + CABINET.d,
		CABINET.x + 8,
		CABINET.x + CABINET.w - 8,
		8,
		24
	),
	{ tone: "lo" }
);
lamp(s, [CABINET.x + CABINET.w - 9, CABINET.y + CABINET.d - 9], CAB_H, {
	radius: 1.8,
});
screws(s, [[CABINET.x + 8, CABINET.y + 8]], CAB_H, 1.4);
// The tube, with clamped collars and a capped bend at the top.
s.solid(cylinder(TUBE[0], TUBE[1], 13, CAB_H, 3, s.P, 36, 0.4), { tone: "lo" });
s.solid(
	cylinder(TUBE[0], TUBE[1], 9, CAB_H + 3, TUBE_TOP - CAB_H - 3, s.P, 36)
);
for (const z of [CAB_H + 18, CAB_H + 32]) {
	s.solid(cylinder(TUBE[0], TUBE[1], 10.5, z, 3, s.P, 36), { tone: "lo" });
}
s.solid(cylinder(TUBE[0], TUBE[1], 11, TUBE_TOP, 4, s.P, 36, 0.6));
s.line(ring(TUBE[0], TUBE[1], 6, TUBE_TOP + 4, s.P, 24), { tone: "mid" });
// Outlet panel on the right: the other channels.
const PANEL = { x: 34, y: -30, w: 34, d: 44, r: 4 };
s.halo(PANEL, 0);
s.solid(slabOf(PANEL, 0, 12, s.P, 4, 0.6));
for (const y of [-20, -6, 6]) {
	jack(s, [PANEL.x + 12, y], 12);
	jack(s, [PANEL.x + 24, y], 12);
}
// Send cup at the front, with the sealed carrier standing in it.
s.halo({ x: CUP[0] - 16, y: CUP[1] - 16, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(CUP[0], CUP[1], 16, 0, 6, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(CUP[0], CUP[1], 12, 6, 6, s.P, 40));
s.solid(cylinder(CUP[0], CUP[1], 9, 12, 10, s.P, 32));
s.solid(cylinder(CUP[0], CUP[1], 9.5, 22, 3, s.P, 32), { tone: "lo" });
s.solid(cylinder(CUP[0], CUP[1], 9, 25, 11, s.P, 32, 0.6));
s.solid(cylinder(CUP[0], CUP[1], 6.5, 36, 3, s.P, 24, 0.6), { lit: true });

export const drawing = cardDrawing(s);
