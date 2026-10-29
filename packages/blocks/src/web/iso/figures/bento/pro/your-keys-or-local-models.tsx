import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	type Point3,
	pathOf,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	jack,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Your keys or local models: a three-way source selector. A rotary switch
 * sits between a managed line socket, a key switch and a local model box;
 * its pointer is turned to the key switch, where your own key (the lit part)
 * is in. Turn it and the same desk runs on either of the other two.
 */

const PLATE = { x: -90, y: -60, w: 180, d: 104, r: 8 };
const SELECT: [number, number] = [-4, 12];
const KEY_BOX = { x: -80, y: -30, w: 32, d: 30, r: 3 };
const KEY_H = 16;
const LINE_BOX = { x: -16, y: -52, w: 34, d: 22, r: 3 };
const LINE_H = 12;
const LOCAL = { x: 40, y: -10, w: 40, d: 38, r: 4 };
const LOCAL_H = 24;
const KEYHOLE: [number, number] = [KEY_BOX.x + 16, KEY_BOX.y + 15];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[KEYHOLE[0], KEYHOLE[1], KEY_H + 22],
]);

benchPlate(s, PLATE);
// Grooves on the plate from the selector out to each source.
for (const to of [
	[KEY_BOX.x + KEY_BOX.w, KEY_BOX.y + KEY_BOX.d / 2],
	[LINE_BOX.x + LINE_BOX.w / 2, LINE_BOX.y + LINE_BOX.d],
	[LOCAL.x, LOCAL.y + LOCAL.d / 2],
] as [number, number][]) {
	s.line(lineOnTop(SELECT, to, 0, s.P), { tone: "lo" });
}
// Key switch: a block with a keyhole and your key turned in it.
s.halo(KEY_BOX, 0);
s.solid(slabOf(KEY_BOX, 0, KEY_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(KEY_BOX, 3), KEY_H, s.P, 3), { tone: "faint" });
s.solid(cylinder(KEYHOLE[0], KEYHOLE[1], 7, KEY_H, 2, s.P, 32), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: KEYHOLE[0] - 1.5, y: KEYHOLE[1] - 2.5, w: 3, d: 5, r: 0.5 },
		KEY_H + 2,
		8,
		s.P,
		2
	),
	{ lit: true }
);
s.solid(
	slabOf(
		{ x: KEYHOLE[0] - 1.5, y: KEYHOLE[1] - 7, w: 3, d: 14, r: 1 },
		KEY_H + 10,
		11,
		s.P,
		4
	),
	{ lit: true }
);
// The hole through the key's bow, on its broad face.
const BOW_HOLE = Array.from({ length: 16 }, (_, i): Point3 => {
	const a = (i / 16) * Math.PI * 2;
	return [
		KEYHOLE[0] + 1.5,
		KEYHOLE[1] + Math.cos(a) * 2.6,
		KEY_H + 17 + Math.sin(a) * 2.6,
	];
});
s.line(pathOf(BOW_HOLE.map(s.at), true), { tone: "mid" });
// Managed line socket at the back: two jacks and a status lamp.
s.halo(LINE_BOX, 0);
s.solid(slabOf(LINE_BOX, 0, LINE_H, s.P, 4, 0.8));
jack(s, [LINE_BOX.x + 9, LINE_BOX.y + 11], LINE_H);
jack(s, [LINE_BOX.x + 19, LINE_BOX.y + 11], LINE_H);
lamp(s, [LINE_BOX.x + 28, LINE_BOX.y + 11], LINE_H, { radius: 1.6 });
// The selector: knurled dial on a collar, pointer at the key switch.
s.halo({ x: SELECT[0] - 20, y: SELECT[1] - 20, w: 40, d: 40, r: 20 }, 0);
s.solid(cylinder(SELECT[0], SELECT[1], 20, 0, 3, s.P, 40, 0.6), {
	tone: "lo",
});
s.line(ring(SELECT[0], SELECT[1], 18, 3, s.P, 40), { tone: "faint" });
s.solid(cylinder(SELECT[0], SELECT[1], 13, 3, 9, s.P, 36, 0.6));
s.line(knurl(SELECT[0], SELECT[1], 13, 4, 12, 32, s.P), { tone: "lo" });
const AIM = Math.atan2(KEYHOLE[1] - SELECT[1], KEYHOLE[0] - SELECT[0]);
const POINT_TO: [number, number] = [
	SELECT[0] + Math.cos(AIM) * 12,
	SELECT[1] + Math.sin(AIM) * 12,
];
s.line(lineOnTop(SELECT, POINT_TO, 12, s.P), {
	tone: "hi",
});
// Local model box: vent rules on its face and a fan grille on top.
const front = LOCAL.y + LOCAL.d;
s.halo(LOCAL, 0);
s.solid(slabOf(LOCAL, 0, LOCAL_H, s.P, 4, 0.8));
screws(
	s,
	[
		[LOCAL.x + 5, LOCAL.y + 5],
		[LOCAL.x + LOCAL.w - 5, LOCAL.y + LOCAL.d - 5],
	],
	LOCAL_H,
	1.3
);
s.line(ring(LOCAL.x + 20, LOCAL.y + 19, 12, LOCAL_H, s.P, 36), { tone: "lo" });
s.line(ring(LOCAL.x + 20, LOCAL.y + 19, 7, LOCAL_H, s.P, 28), {
	tone: "faint",
});
s.line(ring(LOCAL.x + 20, LOCAL.y + 19, 2.5, LOCAL_H, s.P, 16), {
	tone: "mid",
});
faceRules(s, "y", front, LOCAL.x + 6, LOCAL_H - 6, [28, 28, 28], 4);

export const drawing = cardDrawing(s);
