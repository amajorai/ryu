import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Knowledge base search: a card catalogue. Ask a question and one drawer
 * slides open with its index cards on end; the card that answers it (lit)
 * stands up above the rest, still filed in the drawer it came from.
 */

const PLATE = { x: -78, y: -58, w: 128, d: 112, r: 8 };
const CAB = { x: -62, y: -46, w: 92, d: 50, r: 4 };
const FRONT = CAB.y + CAB.d;
const CAB_H = 48;
const DRAWER_Z = [4, 26] as const;
const DRAWER_H = 18;
const DRAWER_X = [CAB.x + 4, CAB.x + 48] as const;
const DRAWER_W = 40;
const OPEN = { x: DRAWER_X[1] + 2, y: FRONT, w: DRAWER_W - 4, d: 38, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H + 2],
]);

/** Label holder and pull on a closed drawer front. */
function drawerFront(x: number, z: number) {
	s.line(faceRect(s, "y", FRONT, x, x + DRAWER_W, z, z + DRAWER_H), {
		tone: "lo",
	});
	const mid = x + DRAWER_W / 2;
	s.line(faceRect(s, "y", FRONT, mid - 7, mid + 7, z + 10, z + 15), {
		tone: "mid",
	});
	s.solid(
		slabOf({ x: mid - 4, y: FRONT, w: 8, d: 2, r: 0.5 }, z + 5, 2.4, s.P, 1)
	);
}

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 4, 1));
s.line(planOutline(insetPlan(CAB, 5), CAB_H, s.P, 3), { tone: "faint" });
knob(s, [CAB.x + CAB.w - 12, CAB.y + 12], CAB_H, 4, 3);
drawerFront(DRAWER_X[0], DRAWER_Z[0]);
drawerFront(DRAWER_X[0], DRAWER_Z[1]);
drawerFront(DRAWER_X[1], DRAWER_Z[1]);
// The empty slot the drawer came out of.
s.line(
	faceRect(
		s,
		"y",
		FRONT,
		DRAWER_X[1],
		DRAWER_X[1] + DRAWER_W,
		DRAWER_Z[0],
		DRAWER_Z[0] + DRAWER_H
	),
	{ tone: "lo" }
);
// The open drawer: floor, far wall, cards on end, near wall, front.
const z0 = DRAWER_Z[0];
s.halo(OPEN, 0, 3);
s.solid(slabOf(OPEN, z0, 2, s.P, 1), { tone: "lo" });
s.solid(slabOf({ ...OPEN, w: 2 }, z0, 12, s.P, 1));
const cards = [6, 12, 18, 24, 30];
for (const y of cards) {
	const lit = y === 18;
	const card = { x: OPEN.x + 4, y: OPEN.y + y, w: OPEN.w - 8, d: 1.6, r: 0 };
	s.solid(slabOf(card, z0 + 2, lit ? 30 : 14, s.P, 1), { lit });
}
s.solid(slabOf({ ...OPEN, x: OPEN.x + OPEN.w - 2, w: 2 }, z0, 12, s.P, 1));
const front = {
	x: OPEN.x - 2,
	y: OPEN.y + OPEN.d,
	w: OPEN.w + 4,
	d: 3,
	r: 0.5,
};
s.solid(slabOf(front, z0, DRAWER_H, s.P, 1));
s.solid(
	slabOf(
		{ x: front.x + front.w / 2 - 4, y: front.y + 3, w: 8, d: 2, r: 0.5 },
		z0 + 5,
		2.4,
		s.P,
		1
	)
);

export const drawing = cardDrawing(s);
