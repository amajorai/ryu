import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Keep the record: an archive box holding one run's three folders side by
 * side: its inputs, its output and its final status. Each folder stands with
 * its tab up; the status tab is the lit one. The stepped lid rests
 * on the bench beside it.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BOX = { x: -70, y: -36, w: 70, d: 62, r: 3 };
const BOX_H = 30;
const WALL = 3;
const FOLDERS = 3;
const FOLDER_D = 50;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-40, -30, 54]]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
// Back and left walls first, then the folders, then the near walls.
const inner = insetPlan(BOX, WALL);
s.solid(slabOf({ ...BOX, d: WALL, r: 1 }, 0, BOX_H, s.P, 2));
s.solid(slabOf({ ...BOX, w: WALL, r: 1 }, 0, BOX_H, s.P, 2));
s.solid(slabOf({ ...inner, r: 1 }, 0, 2, s.P, 2), { tone: "lo" });
for (let i = 0; i < FOLDERS; i++) {
	const x = inner.x + 10 + i * 20;
	const y = inner.y + 3;
	const tabY = y + 6 + i * 14;
	s.solid(slabOf({ x, y, w: 3, d: FOLDER_D, r: 0.5 }, 2, BOX_H + 8, s.P, 2), {
		crease: "none",
	});
	s.solid(slabOf({ x, y: tabY, w: 3, d: 14, r: 0.5 }, BOX_H + 10, 7, s.P, 2), {
		lit: i === FOLDERS - 1,
		crease: "none",
	});
}
s.solid(
	slabOf({ ...BOX, x: BOX.x + BOX.w - WALL, w: WALL, r: 1 }, 0, BOX_H, s.P, 2)
);
s.solid(
	slabOf({ ...BOX, y: BOX.y + BOX.d - WALL, d: WALL, r: 1 }, 0, BOX_H, s.P, 2)
);
// Hand hole on the front face.
s.line(faceRect(s, "y", BOX.y + BOX.d, BOX.x + 24, BOX.x + 46, 20, 25), {
	tone: "lo",
});
// The lid, lying beside the box: a stepped rim with a label holder on top.
const lid = { x: 18, y: -30, w: 66, d: 58, r: 3 };
const lidTop = insetPlan(lid, 4);
s.halo(lid, 0);
s.solid(slabOf(lid, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(lidTop, 4, 4, s.P, 3, 0.6));
const holder = { x: 36, y: -10, w: 30, d: 16, r: 1.5 };
s.solid(slabOf(holder, 8, 1.2, s.P, 2), { tone: "lo" });
s.line(planOutline(insetPlan(holder, 2.5), 9.2, s.P, 1), { tone: "faint" });
screws(
	s,
	[
		[holder.x + 2.5, holder.y + holder.d / 2],
		[holder.x + holder.w - 2.5, holder.y + holder.d / 2],
	],
	9.2,
	0.9
);

export const drawing = cardDrawing(s);
