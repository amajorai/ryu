import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	jack,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Managed node included: a three-bay rack sled. One node is already seated
 * in its bay and powered (the lit lamp); the other two bays stand empty on
 * their rails, ready for the extra nodes a team plan adds.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const TRAY = { x: -90, y: -30, w: 180, d: 66, r: 4 };
const TRAY_H = 5;
const BACK = { x: -90, y: -40, w: 180, d: 10, r: 2 };
const BACK_H = 30;
const BAYS = [-60, 0, 60] as const;
const NODE_H = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -40, BACK_H + 2],
]);

benchPlate(s, PLATE);
// Backplane: the wall each node plugs into.
s.halo(BACK, 0);
s.solid(slabOf(BACK, 0, BACK_H, s.P, 4, 0.6));
s.line(planOutline(insetPlan(BACK, 2), BACK_H, s.P, 2), { tone: "faint" });
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[TRAY.x + 6, TRAY.y + TRAY.d - 6],
		[TRAY.x + TRAY.w - 6, TRAY.y + TRAY.d - 6],
	],
	TRAY_H,
	1.4
);
const backFace = BACK.y + BACK.d;
for (const [index, cx] of BAYS.entries()) {
	if (index === BAYS.length - 1) {
		break;
	}
	// An empty bay: its socket on the backplane and its two guide rails.
	s.line(faceRect(s, "y", backFace, cx - 12, cx + 12, 12, 20), {
		tone: "mid",
	});
	jack(s, [cx, backFace + 6], TRAY_H);
	for (const rx of [cx - 22, cx + 22]) {
		s.solid(
			slabOf(
				{ x: rx - 2, y: TRAY.y + 4, w: 4, d: TRAY.d - 8, r: 1 },
				TRAY_H,
				3,
				s.P,
				2
			)
		);
	}
	s.line(
		lineOnTop(
			[cx - 16, TRAY.y + TRAY.d - 4],
			[cx + 16, TRAY.y + TRAY.d - 4],
			TRAY_H,
			s.P
		),
		{
			tone: "faint",
		}
	);
}
// The included node, seated in the nearest bay.
const cx = BAYS[2];
const node = { x: cx - 25, y: TRAY.y + 2, w: 50, d: TRAY.d - 2, r: 3 };
s.halo(node, TRAY_H);
s.solid(slabOf(node, TRAY_H, NODE_H, s.P, 4, 0.8));
const top = TRAY_H + NODE_H;
s.line(planOutline(insetPlan(node, 4), top, s.P, 2), { tone: "faint" });
const front = node.y + node.d;
faceRules(s, "y", front, node.x + 8, top - 7, [34, 34, 34], 4);
s.solid(
	slabOf(
		{ x: node.x + 38, y: front, w: 6, d: 3, r: 1 },
		TRAY_H + 6,
		12,
		s.P,
		2
	),
	{ tone: "lo" }
);
lamp(s, [node.x + node.w - 9, front - 8], top, { lit: true, radius: 3 });
lamp(s, [node.x + node.w - 17, front - 8], top, { radius: 1.6 });

export const drawing = cardDrawing(s);
