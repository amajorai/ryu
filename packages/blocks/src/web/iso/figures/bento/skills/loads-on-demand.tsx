import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Loads on demand: a card-catalogue cabinet. Every drawer shows only its
 * label up front, like a skill's short description; one drawer has been
 * pulled out because it was needed, and its full set of cards (the lit card
 * raised) is open to read.
 */

const PLATE = { x: -56, y: -64, w: 108, d: 108, r: 8 };
const CAB = { x: -34, y: -52, w: 64, d: 44, r: 3 };
const CAB_H = 66;
const ROW = 20;
const BASE = 3;
const FRONT = CAB.y + CAB.d;
const OPEN_ROW = 0;
const PULL = 38;
const DRAWER_X = CAB.x + 4;
const DRAWER_W = CAB.w - 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H + 4],
]);

const rowZ = (row: number) => BASE + row * (ROW + 1);

function pull(y: number, z0: number) {
	const mid = DRAWER_X + DRAWER_W / 2;
	s.line(faceRect(s, "y", y, mid - 9, mid + 9, z0 + 11, z0 + 15), {
		tone: "lo",
	});
	s.solid(slabOf({ x: mid - 7, y, w: 14, d: 2.4, r: 0.8 }, z0 + 4, 3, s.P, 2), {
		tone: "lo",
	});
}

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 4, 1));
s.line(planOutline(insetPlan(CAB, 4), CAB_H, s.P, 4), { tone: "faint" });
lamp(s, [CAB.x + CAB.w - 10, CAB.y + 10], CAB_H, { radius: 2 });
// Closed drawers: each shows only a label holder and a pull.
for (let row = 0; row < 3; row += 1) {
	const z0 = rowZ(row);
	s.line(faceRect(s, "y", FRONT, DRAWER_X, DRAWER_X + DRAWER_W, z0, z0 + ROW), {
		tone: row === OPEN_ROW ? "lo" : "mid",
	});
	if (row !== OPEN_ROW) {
		pull(FRONT, z0);
	}
}
// The drawer that was opened, pulled out toward the viewer.
const z0 = rowZ(OPEN_ROW);
const body = { x: DRAWER_X + 1, y: FRONT, w: DRAWER_W - 2, d: PULL, r: 1 };
s.halo(body, 0, 3);
const WALL_H = ROW - 3;
// Hollow drawer: floor, back and far side first, cards, then the near side.
s.solid(slabOf(body, z0, 2, s.P, 2), { tone: "lo" });
s.solid(slabOf({ ...body, d: 2, r: 0.5 }, z0 + 2, WALL_H - 2, s.P, 2));
s.solid(slabOf({ ...body, w: 2, r: 0.5 }, z0 + 2, WALL_H - 2, s.P, 2));
for (const [index, y] of [7, 13, 19, 25, 31].entries()) {
	const lit = index === 2;
	const plan = {
		x: DRAWER_X + 6,
		y: FRONT + y,
		w: DRAWER_W - 12,
		d: 1.6,
		r: 0,
	};
	s.solid(slabOf(plan, z0 + 2, ROW + 3 + (lit ? 9 : 0), s.P, 2), {
		lit,
		tone: "hi",
	});
}
s.solid(
	slabOf(
		{ ...body, x: body.x + body.w - 2, w: 2, r: 0.5 },
		z0 + 2,
		WALL_H - 2,
		s.P,
		2
	)
);
const panelY = FRONT + PULL;
s.solid(
	slabOf(
		{ x: DRAWER_X, y: panelY, w: DRAWER_W, d: 3, r: 1 },
		z0,
		ROW,
		s.P,
		2,
		0.3
	)
);
pull(panelY + 3, z0);
screws(
	s,
	[
		[CAB.x + 6, CAB.y + 6],
		[CAB.x + CAB.w - 6, CAB.y + CAB.d - 6],
	],
	CAB_H,
	1.4
);

export const drawing = cardDrawing(s);
