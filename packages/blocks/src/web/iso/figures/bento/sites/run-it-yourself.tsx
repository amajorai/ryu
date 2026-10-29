import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Run it yourself: your own tower server standing on your own bench, wired to
 * a power block you control. The lit toggle on the block is your switch; no
 * one else's machine is involved.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TOWER = { x: -62, y: -36, w: 44, d: 64, r: 4 };
const TOWER_H = 62;
const BLOCK = { x: 16, y: -2, w: 52, d: 34, r: 4 };
const BLOCK_H = 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-40, 0, TOWER_H + 4],
]);

benchPlate(s, PLATE);
// Tower server: drive bays down its front, a vent grille on its side.
s.halo(TOWER, 0);
s.solid(slabOf(TOWER, 0, TOWER_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(TOWER, 4), TOWER_H, s.P, 6), { tone: "faint" });
const front = TOWER.y + TOWER.d;
for (let i = 0; i < 4; i++) {
	const top = TOWER_H - 8 - i * 10;
	s.line(
		faceRect(s, "y", front, TOWER.x + 6, TOWER.x + TOWER.w - 6, top - 7, top),
		{
			tone: i === 0 ? "mid" : "lo",
		}
	);
}
const side = TOWER.x + TOWER.w;
for (let i = 0; i < 6; i++) {
	const y = TOWER.y + 12 + i * 7;
	s.line(faceRect(s, "x", side, y, y + 3, 10, 40), { tone: "faint" });
}
lamp(s, [TOWER.x + TOWER.w - 9, TOWER.y + TOWER.d - 9], TOWER_H, {
	radius: 1.8,
});
screws(
	s,
	[
		[TOWER.x + 8, TOWER.y + 8],
		[TOWER.x + TOWER.w - 8, TOWER.y + 8],
	],
	TOWER_H,
	1.4
);
// Power cord from the tower's foot to the block.
s.wire([TOWER.x + TOWER.w, 0, 4], [BLOCK.x, BLOCK.y + 10, 4], [], {
	tone: "mid",
});
// Power block with its toggle thrown on.
s.halo(BLOCK, 0);
s.solid(slabOf(BLOCK, 0, BLOCK_H, s.P, 6, 1));
screws(
	s,
	[
		[BLOCK.x + 6, BLOCK.y + 6],
		[BLOCK.x + BLOCK.w - 6, BLOCK.y + BLOCK.d - 6],
	],
	BLOCK_H,
	1.4
);
const plate = { x: BLOCK.x + 14, y: BLOCK.y + 9, w: 16, d: 16, r: 2 };
s.solid(slabOf(plate, BLOCK_H, 1.2, s.P, 3), { tone: "lo" });
s.solid(cylinder(plate.x + 8, plate.y + 8, 2.4, BLOCK_H + 1.2, 16, s.P, 16), {
	lit: true,
});
s.solid(cylinder(plate.x + 8, plate.y + 8, 4, BLOCK_H + 17.2, 4, s.P, 20), {
	lit: true,
});
s.solid(
	cylinder(BLOCK.x + BLOCK.w - 12, BLOCK.y + 12, 3.4, BLOCK_H, 1.6, s.P, 20),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
