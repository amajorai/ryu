import {
	boxCorners,
	cylinder,
	dotGrid,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Mini chat: a desk intercom. A speaker grille for the reply, two small
 * lamps, and one big talk button (the lit part): tap it to chat, hold it to
 * talk into the microphone standing beside it.
 */

const PLATE = { x: -84, y: -50, w: 168, d: 96, r: 8 };
const BODY = { x: -68, y: -36, w: 90, d: 70, r: 8 };
const BODY_H = 16;
const BUTTON: [number, number] = [-4, 12];
const MIC: [number, number] = [54, 20];
const MIC_TOP = 58;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[MIC[0], MIC[1], MIC_TOP],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 6), { tone: "faint" });
// Speaker grille on the far half of the top.
s.solid(slabOf({ x: -58, y: -28, w: 36, d: 36, r: 4 }, BODY_H, 1, s.P, 4), {
	tone: "lo",
	crease: "none",
});
s.dots(dotGrid(-54, -24, 8, 8, 4, BODY_H + 1, s.P), { size: 0.9, tone: "hi" });
lamp(s, [2, -22], BODY_H, { radius: 1.8 });
lamp(s, [12, -22], BODY_H, { radius: 1.8 });
screws(
	s,
	[
		[BODY.x + 8, BODY.y + BODY.d - 8],
		[BODY.x + BODY.w - 8, BODY.y + 8],
	],
	BODY_H,
	1.4
);
// The talk button in its collar.
s.solid(cylinder(BUTTON[0], BUTTON[1], 15, BODY_H, 2, s.P, 40), {
	tone: "lo",
});
s.solid(cylinder(BUTTON[0], BUTTON[1], 11.5, BODY_H + 2, 5, s.P, 40, 0.8), {
	lit: true,
});
// The microphone on its stand.
s.halo({ x: MIC[0] - 15, y: MIC[1] - 15, w: 30, d: 30, r: 15 }, 0);
s.solid(cylinder(MIC[0], MIC[1], 14, 0, 4, s.P, 36, 0.6), { tone: "lo" });
s.solid(cylinder(MIC[0], MIC[1], 2.8, 4, 28, s.P, 20));
s.solid(cylinder(MIC[0], MIC[1], 5, 32, 3, s.P, 24), { tone: "lo" });
s.solid(cylinder(MIC[0], MIC[1], 8, 35, MIC_TOP - 35, s.P, 32, 1.2));
s.line(knurl(MIC[0], MIC[1], 8, 37, MIC_TOP - 3, 28, s.P), { tone: "lo" });
s.line(ring(MIC[0], MIC[1], 4.5, MIC_TOP, s.P, 24), { tone: "lo" });
export const drawing = cardDrawing(s);
