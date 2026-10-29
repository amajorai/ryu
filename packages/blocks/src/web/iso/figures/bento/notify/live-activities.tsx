import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, ruler, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Live activities: a fader desk. Each slot is one live progress stream and its
 * slider sits at how far that run has got; one stream is moving right now (the
 * lit slider).
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const DESK = { x: -78, y: -42, w: 150, d: 84, r: 5 };
const DESK_H = 14;
const ROWS = [0.82, 0.35, 0.6, 1, 0.18, 0.7, 0.46];
const TRACK_X = -58;
const TRACK_W = 100;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, DESK_H + 8]]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DESK, 4), DESK_H, s.P, 4), { tone: "faint" });
ruler(s, { x: TRACK_X, y: DESK.y + 6, w: TRACK_W, d: 5, r: 1 }, DESK_H);
ROWS.forEach((progress, index) => {
	const y = DESK.y + 20 + index * 9.4;
	s.line(
		planOutline(
			{ x: TRACK_X, y: y - 1.5, w: TRACK_W, d: 3, r: 1.5 },
			DESK_H,
			s.P,
			3
		),
		{
			tone: "lo",
		}
	);
	lamp(s, [DESK.x + 10, y], DESK_H, { radius: 1.6 });
	const x = TRACK_X + progress * (TRACK_W - 12);
	s.solid(
		slabOf({ x, y: y - 4, w: 12, d: 8, r: 1.5 }, DESK_H, 7, s.P, 3, 0.4),
		{
			lit: index === 2,
		}
	);
	lamp(s, [DESK.x + DESK.w - 14, y], DESK_H, { radius: 1.6 });
});
screws(s, [[DESK.x + DESK.w - 6, DESK.y + 6]], DESK_H, 1.4);

export const drawing = cardDrawing(s);
