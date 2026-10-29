import { boxCorners, cylinder, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Agent inboxes: a row of post mailboxes, one per agent, running the length
 * of the bench (and as many more as you need). Each has a door with a letter
 * slot; one has mail waiting and its flag raised (the lit part).
 */

const PLATE = { x: -104, y: -34, w: 208, d: 68, r: 8 };
const POSTS = [-72, -24, 24, 72];
const RAISED = 2;
const POST_H = 22;
const BOX_H = 16;
const BOX_W = 22;
const BOX_D = 32;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[POSTS[0] ?? 0, -16, POST_H + BOX_H + 4],
	[POSTS[RAISED] ?? 0, 0, POST_H + BOX_H + 14],
]);

function mailbox(cx: number, raised: boolean, mail: boolean) {
	const box = { x: cx - BOX_W / 2, y: -BOX_D / 2, w: BOX_W, d: BOX_D, r: 6 };
	const top = POST_H + BOX_H;
	const front = box.y + box.d;
	const side = box.x + box.w;
	s.halo({ x: cx - 8, y: -8, w: 16, d: 16, r: 8 }, 0);
	s.solid(cylinder(cx, 0, 7, 0, 2, s.P, 28), { tone: "lo" });
	s.solid(cylinder(cx, 0, 3, 2, POST_H - 2, s.P, 20));
	s.solid(slabOf(box, POST_H, BOX_H, s.P, 8, 1.2));
	// Door with a hinge line and a latch.
	s.line(faceRect(s, "y", front, box.x + 4, side - 4, POST_H + 2, top - 3), {
		tone: "mid",
	});
	s.line(faceRect(s, "y", front, cx - 1.5, cx + 1.5, top - 7, top - 5), {
		tone: "lo",
	});
	if (mail) {
		s.solid(
			slabOf(
				{ x: cx - 6, y: front - 3, w: 12, d: 7, r: 0.4 },
				POST_H + 7,
				1.2,
				s.P,
				2
			),
			{ crease: "none" }
		);
	}
	// Flag on the side: raised upright, or folded flat along the box.
	const flagArm = raised
		? {
				plan: { x: side, y: 4, w: 1.6, d: 3, r: 0.3 },
				z: POST_H + 4,
				h: BOX_H + 6,
			}
		: { plan: { x: side, y: -10, w: 1.6, d: 17, r: 0.3 }, z: POST_H + 6, h: 3 };
	s.solid(cylinder(side + 0.8, 5.5, 2, POST_H + 4, 1, s.P, 16), { tone: "lo" });
	s.solid(slabOf(flagArm.plan, flagArm.z, flagArm.h, s.P, 2), {
		lit: raised,
		crease: "none",
	});
	if (raised) {
		s.solid(
			slabOf({ x: side, y: -4, w: 1.6, d: 11, r: 0.3 }, top + 2, 8, s.P, 2),
			{ lit: true, crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
POSTS.forEach((cx, index) => {
	mailbox(cx, index === RAISED, index === 0);
});

export const drawing = cardDrawing(s);
