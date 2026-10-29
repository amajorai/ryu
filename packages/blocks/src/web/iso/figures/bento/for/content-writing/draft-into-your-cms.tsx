import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	jack,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Draft into your CMS: a filing cabinet. The finished draft (the lit sheet)
 * drops through the slot on top and is filed into a drawer, which stands
 * open; the cabinet is wired to the connector box beside it, the connected
 * app that does the saving.
 */

const PLATE = { x: -84, y: -56, w: 168, d: 112, r: 8 };
const CAB = { x: -46, y: -42, w: 60, d: 58, r: 4 };
const CAB_H = 58;
const DRAWER_H = 17;
const LINK = { x: 34, y: -34, w: 30, d: 26, r: 3 };
const LINK_H = 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x + 30, CAB.y + 26, CAB_H + 16],
]);

benchPlate(s, PLATE);
// Cabinet with its feed slot.
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 4, 1));
s.line(planOutline(insetPlan(CAB, 4), CAB_H, s.P, 3), { tone: "faint" });
const slot = { x: CAB.x + 10, y: CAB.y + 24, w: 40, d: 4, r: 1 };
s.line(planOutline(slot, CAB_H, s.P, 2), { tone: "mid" });
s.solid(
	slabOf(
		{ x: slot.x + 3, y: slot.y + 1, w: 34, d: 2, r: 0.4 },
		CAB_H,
		16,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// Drawers on the front face; the middle one is pulled open.
const front = CAB.y + CAB.d;
for (const index of [0, 2]) {
	const z0 = 4 + index * DRAWER_H;
	s.line(
		faceRect(
			s,
			"y",
			front,
			CAB.x + 4,
			CAB.x + CAB.w - 4,
			z0,
			z0 + DRAWER_H - 2
		),
		{
			tone: "lo",
		}
	);
	s.solid(
		slabOf({ x: CAB.x + 22, y: front, w: 16, d: 3, r: 1 }, z0 + 9, 3, s.P, 2),
		{ tone: "lo" }
	);
}
const open = { x: CAB.x + 4, y: front, w: CAB.w - 8, d: 22, r: 1 };
const openZ = 4 + DRAWER_H;
s.solid(slabOf(open, openZ, DRAWER_H - 2, s.P, 2, 0.4));
s.line(planOutline(insetPlan(open, 3), openZ + DRAWER_H - 2, s.P, 2), {
	tone: "lo",
});
for (const y of [front + 6, front + 10, front + 14]) {
	s.solid(
		slabOf(
			{ x: open.x + 6, y, w: open.w - 12, d: 1.2, r: 0.2 },
			openZ + DRAWER_H - 2,
			4,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
s.solid(
	slabOf(
		{ x: CAB.x + 22, y: open.y + open.d, w: 16, d: 3, r: 1 },
		openZ + 7,
		3,
		s.P,
		2
	),
	{ tone: "lo" }
);
// Connector box to the right, cabled to the cabinet's side.
s.halo(LINK, 0);
s.solid(slabOf(LINK, 0, LINK_H, s.P, 4, 0.8));
lamp(s, [LINK.x + 8, LINK.y + 8], LINK_H, { radius: 1.8 });
jack(s, [LINK.x + 20, LINK.y + 16], LINK_H);
s.wire(
	[LINK.x + 20, LINK.y + 16, LINK_H],
	[CAB.x + CAB.w, -22, 20],
	[
		[LINK.x + 20, LINK.y + 16, 22],
		[CAB.x + CAB.w + 6, -22, 22],
	],
	{ tone: "mid" }
);
screws(
	s,
	[
		[CAB.x + 8, CAB.y + 8],
		[CAB.x + CAB.w - 8, CAB.y + 8],
	],
	CAB_H,
	1.4
);

export const drawing = cardDrawing(s);
