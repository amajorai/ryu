import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Admin access: a managed node cabinet whose door answers only to the badge
 * reader beside it. The admin badge laid on the reader (the lit part) is the
 * one thing that opens Agent on this node.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const NODE = { x: -76, y: -40, w: 78, d: 62, r: 4 };
const NODE_H = 50;
const READER: [number, number] = [48, 14];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-40, 0, NODE_H + 4],
]);

benchPlate(s, PLATE);
// Node cabinet: vents on the side, a closed door with a latch on the front.
s.halo(NODE, 0);
s.solid(slabOf(NODE, 0, NODE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(NODE, 5), NODE_H, s.P, 4), { tone: "faint" });
const front = NODE.y + NODE.d;
const side = NODE.x + NODE.w;
faceRules(s, "x", side, NODE.y + 10, NODE_H - 10, [40, 40, 40, 40, 40], 5);
s.line(
	faceRect(s, "y", front, NODE.x + 6, NODE.x + NODE.w - 6, 5, NODE_H - 6),
	{
		tone: "lo",
	}
);
s.solid(slabOf({ x: -12, y: front, w: 4, d: 3, r: 1 }, 18, 16, s.P, 2, 0.3), {
	tone: "lo",
});
lamp(s, [NODE.x + 14, NODE.y + 12], NODE_H, { radius: 2 });
lamp(s, [NODE.x + 24, NODE.y + 12], NODE_H, { radius: 2 });
screws(
	s,
	[
		[NODE.x + 10, front - 10],
		[side - 10, front - 10],
	],
	NODE_H,
	1.6
);
// Cable from the reader into the cabinet's side.
s.wire([READER[0] - 6, READER[1], 8], [side, READER[1], 8], [], { tone: "lo" });
// Badge reader pedestal with the admin badge on its pad.
const [rx, ry] = READER;
s.halo({ x: rx - 13, y: ry - 13, w: 26, d: 26, r: 13 }, 0);
s.solid(cylinder(rx, ry, 13, 0, 3, s.P, 36, 0.6), { tone: "lo" });
s.solid(
	slabOf({ x: rx - 6, y: ry - 6, w: 12, d: 12, r: 2 }, 3, 22, s.P, 3, 0.4)
);
const pad = { x: rx - 15, y: ry - 12, w: 30, d: 24, r: 3 };
s.halo(pad, 25);
s.solid(slabOf(pad, 25, 6, s.P, 4, 0.8));
lamp(s, [rx + 10, ry - 8], 31, { radius: 1.6 });
const badge = { x: rx - 10, y: ry - 5, w: 18, d: 13, r: 1.5 };
s.solid(slabOf(badge, 31, 1.4, s.P, 3, 0.2), { lit: true });
s.line(ring(rx - 6, ry + 1.5, 1.4, 32.4, s.P, 16), { tone: "lo" });

export const drawing = cardDrawing(s);
