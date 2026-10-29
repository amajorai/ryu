import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Line edit suggestions: a selector console with one slider per sentence.
 * Each slider moves between the original wording (left stop) and the tighter
 * suggestion (right stop). Settled sentences sit at a stop; the current one
 * waits in the middle (the lit slider) for the editor to choose.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const DESK = { x: -72, y: -42, w: 124, d: 84, r: 5 };
const DESK_H = 14;
const TRACK_X = DESK.x + 12;
const TRACK_W = 78;
const SETTINGS = [0, 1, 1, 0.5, 0];
const CURRENT = 3;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, DESK_H + 10]]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DESK, 4), DESK_H, s.P, 4), { tone: "faint" });
SETTINGS.forEach((setting, i) => {
	const y = DESK.y + 14 + i * 14;
	s.line(
		planOutline(
			{ x: TRACK_X, y: y - 1.6, w: TRACK_W, d: 3.2, r: 1.6 },
			DESK_H,
			s.P,
			3
		),
		{ tone: "lo" }
	);
	const x = TRACK_X + 2 + setting * (TRACK_W - 14);
	s.solid(
		slabOf({ x, y: y - 4, w: 10, d: 8, r: 1.5 }, DESK_H, 6, s.P, 3, 0.5),
		{ lit: i === CURRENT }
	);
	lamp(s, [DESK.x + DESK.w - 18, y], DESK_H, { radius: 1.5 });
});
knob(s, [DESK.x + DESK.w - 6 - 4, DESK.y + 10], DESK_H, 3.5, 4);
screws(
	s,
	[
		[DESK.x + 6, DESK.y + DESK.d - 6],
		[DESK.x + DESK.w - 6, DESK.y + DESK.d - 6],
	],
	DESK_H,
	1.4
);
// The editor's commit key in front of the console.
const key = { x: 58, y: 10, w: 22, d: 22, r: 3 };
s.halo(key, 0);
s.solid(slabOf(key, 0, 4, s.P, 4, 0.5), { tone: "lo" });
s.solid(slabOf(insetPlan(key, 3), 4, 5, s.P, 4, 0.6));

export const drawing = cardDrawing(s);
