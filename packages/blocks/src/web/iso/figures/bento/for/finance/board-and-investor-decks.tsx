import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	radialTicks,
	sideRing,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Board and investor decks: a slide projector with a round carousel on top.
 * The month's slides wait in its slots; the one standing up in the gate (lit)
 * is the slide going in front of the board next. A wired clicker waits on the
 * bench for the presenter.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BODY = { x: -58, y: -34, w: 88, d: 60, r: 5 };
const BODY_H = 28;
const TRAY: [number, number] = [-16, -4];
const TRAY_R = 25;
const TRAY_H = 7;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TRAY[0], TRAY[1], BODY_H + 30],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 4), BODY_H, s.P, 5), { tone: "faint" });
faceRules(s, "y", BODY.y + BODY.d, BODY.x + 10, 18, [16, 16, 16], 4);
knob(s, [BODY.x + BODY.w - 12, BODY.y + BODY.d - 10], BODY_H, 4, 4);
// Carousel: a round tray of slots with a hub, one slide raised in the gate.
const top = BODY_H + TRAY_H;
s.solid(cylinder(TRAY[0], TRAY[1], TRAY_R + 2, BODY_H, 2, s.P, 48), {
	tone: "lo",
});
s.solid(
	cylinder(TRAY[0], TRAY[1], TRAY_R, BODY_H + 2, TRAY_H - 2, s.P, 48, 0.6)
);
const slots = radialTicks(
	TRAY[0],
	TRAY[1],
	TRAY_R - 2,
	36,
	6,
	top,
	[8, 8],
	s.P
);
s.line(slots.minor, { tone: "lo" });
s.line(slots.major, { tone: "lo" });
s.solid(cylinder(TRAY[0], TRAY[1], 6, top, 4, s.P, 24), { tone: "lo" });
s.solid(
	slabOf(
		{ x: TRAY[0] - 8, y: TRAY[1] + 13, w: 16, d: 2.4, r: 0.4 },
		top - 4,
		22,
		s.P,
		2
	),
	{ lit: true }
);
// Lens barrel on the right face, rings marking the glass.
const lens = { x: BODY.x + BODY.w, y: -12, w: 18, d: 22, r: 3 };
s.solid(slabOf(lens, 4, 20, s.P, 4, 0.8));
const face = lens.x + lens.w;
s.line(sideRing([face, lens.y + lens.d / 2, 14], 8, "x", s.P, 32), {
	tone: "mid",
});
s.line(sideRing([face, lens.y + lens.d / 2, 14], 5, "x", s.P, 32), {
	tone: "lo",
});
// Clicker, cabled to the body.
const clicker = { x: 40, y: 30, w: 22, d: 14, r: 4 };
s.halo(clicker, 0);
s.solid(slabOf(clicker, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(clicker.x + 7, clicker.y + 7, 3.6, 5, 2, s.P, 20));
s.solid(cylinder(clicker.x + 16, clicker.y + 7, 2.4, 5, 1.6, s.P, 20), {
	tone: "lo",
});
s.wire(
	[BODY.x + BODY.w - 6, BODY.y + BODY.d, 4],
	[clicker.x, clicker.y + 7, 3]
);

export const drawing = cardDrawing(s);
