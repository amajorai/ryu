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
	faceLine,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";
import { ribbon } from "./ribbon.ts";

/*
 * No setup: a turnkey appliance, already plugged in. Where a model selector
 * would sit there is only a blank plate screwed shut; the one thing to touch
 * is the big start button (the lit part).
 */

const PLATE = { x: -76, y: -46, w: 150, d: 84, r: 8 };
const BOX = { x: -64, y: -36, w: 88, d: 62, r: 6 };
const BOX_H = 30;
const BLANK = { x: BOX.x + 8, y: BOX.y + 8, w: 32, d: 24, r: 2 };
const BUTTON: [number, number] = [BOX.x + 64, BOX.y + 30];
const OUTLET = { x: 38, y: -34, w: 26, d: 12, r: 2 };
const OUTLET_H = 30;
const OUTLET_FRONT = OUTLET.y + OUTLET.d;
const PLUG = { x: 44, y: OUTLET_FRONT, w: 14, d: 8, r: 2 };
const SIDE = BOX.x + BOX.w;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BOX_H + 12]]);

benchPlate(s, PLATE);
// The appliance body.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 6), { tone: "faint" });
faceRules(s, "y", BOX.y + BOX.d, BOX.x + 10, 20, [44, 44, 44], 4);
lamp(s, [BOX.x + BOX.w - 10, BOX.y + BOX.d - 9], BOX_H, { radius: 1.8 });
// Blank cover where a selector would be: nothing to choose.
s.solid(slabOf(BLANK, BOX_H, 1.4, s.P, 3, 0.3), { tone: "lo" });
screws(s, corners(BLANK, 4), BOX_H + 1.4, 1.1);
// The start button in its collar.
s.solid(cylinder(BUTTON[0], BUTTON[1], 14, BOX_H, 2.4, s.P, 40, 0.4), {
	tone: "lo",
});
s.solid(cylinder(BUTTON[0], BUTTON[1], 10.5, BOX_H + 2.4, 5, s.P, 40, 0.8), {
	lit: true,
});
s.line(ring(BUTTON[0], BUTTON[1], 6, BOX_H + 7.4, s.P, 32), { tone: "mid" });
// The wall outlet, its upper socket free and the plug seated in the lower one.
s.halo(OUTLET, 0);
s.solid(slabOf(OUTLET, 0, OUTLET_H, s.P, 4, 0.6));
s.line(faceRect(s, "y", OUTLET_FRONT, 44, 58, 17, 26), { tone: "mid" });
for (const x of [48, 54]) {
	s.line(faceLine(s, "y", OUTLET_FRONT, x, x + 1.5, 21.5), { tone: "mid" });
}
s.solid(slabOf(PLUG, 0, 12, s.P, 3, 0.6), { tone: "lo" });
// The cord, already run along the bench into the appliance's side.
ribbon(
	s,
	[
		[51, PLUG.y + PLUG.d - 1],
		[51, 7],
		[SIDE, 7],
	],
	0,
	2.6,
	2.8
);
s.solid(cylinder(51, 7, 1.4, 0, 2.6, s.P, 16), { crease: "none" });
s.solid(slabOf({ x: SIDE, y: 3, w: 5, d: 8, r: 1.5 }, 0, 5.5, s.P, 3, 0.4));

export const drawing = cardDrawing(s);
