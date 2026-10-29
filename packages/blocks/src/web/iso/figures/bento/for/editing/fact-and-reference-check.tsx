import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, jack, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Fact and reference check: a two-pan bench balance. The source from the
 * Space sits on the far pan, the claim on the near one; when they do not
 * weigh the same, the flag on the pillar goes up (the lit flag) for a person
 * to verify.
 */

const PLATE = { x: -92, y: -50, w: 184, d: 100, r: 8 };
const BASE = { x: -62, y: -20, w: 124, d: 40, r: 5 };
const BASE_H = 14;
const PAN_R = 21;
const PAN_Z = 26;
const LEFT = -38;
const RIGHT = 38;
const BEAM = { x: 0, y: -2.5, w: 0, d: 5, r: 1 };
const BEAM_Z = 19;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 54]]);

function pan(x: number) {
	s.solid(cylinder(x, 0, PAN_R, PAN_Z, 3, s.P, 48, 0.6));
	s.line(ring(x, 0, PAN_R - 3, PAN_Z + 3, s.P, 48), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
faceRules(s, "y", BASE.y + BASE.d, -20, 10, [40, 28], 4);
// Pan posts, then the beam that joins them through the pillar's pivot.
for (const x of [LEFT, RIGHT]) {
	s.solid(cylinder(x, 0, 3, BASE_H, PAN_Z - BASE_H, s.P, 20));
}
s.solid(slabOf({ ...BEAM, x: LEFT, w: -LEFT - 3 }, BEAM_Z, 4, s.P, 2), {
	tone: "lo",
});
// Centre pillar with the flag raised.
s.solid(cylinder(0, 0, 4, BASE_H, 34, s.P, 24));
s.solid(cylinder(0, 0, 5.5, BASE_H + 34, 3, s.P, 24), { tone: "lo" });
s.solid(slabOf({ ...BEAM, x: 3, w: RIGHT - 3 }, BEAM_Z, 4, s.P, 2), {
	tone: "lo",
});
pan(LEFT);
// The source: a bound volume lying on the far pan.
const book = { x: LEFT - 12, y: -9, w: 24, d: 18, r: 2 };
s.solid(slabOf(book, PAN_Z + 3, 8, s.P, 3, 0.6));
s.line(planOutline(insetPlan(book, 3), PAN_Z + 11, s.P, 2), { tone: "faint" });
s.solid(slabOf({ x: 4, y: -1, w: 18, d: 2, r: 0.4 }, BASE_H + 22, 12, s.P, 2), {
	lit: true,
	crease: "none",
});
jack(s, [0, 12], BASE_H);
pan(RIGHT);
// The claim: a single slip on the near pan.
s.solid(
	slabOf({ x: RIGHT - 9, y: -7, w: 18, d: 14, r: 1.5 }, PAN_Z + 3, 2, s.P, 3),
	{
		crease: "none",
	}
);
screws(
	s,
	[
		[BASE.x + 7, 12],
		[BASE.x + BASE.w - 7, -12],
	],
	BASE_H,
	1.4
);

export const drawing = cardDrawing(s);
