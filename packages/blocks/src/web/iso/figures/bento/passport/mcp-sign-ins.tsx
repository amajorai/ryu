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
 * MCP sign-ins: a remote server tower, mast up, with a key-tag dock wired to
 * its side. The server's sign-in is the tag seated in the dock (the lit
 * part), kept on the bench beside the machine it opens.
 */

const PLATE = { x: -84, y: -50, w: 172, d: 96, r: 8 };
const TOWER = { x: -62, y: -38, w: 46, d: 56, r: 4 };
const TOWER_H = 50;
const MAST: [number, number] = [-50, -26];
const MAST_H = 22;
const DOCK = { x: 20, y: -6, w: 50, d: 36, r: 4 };
const DOCK_H = 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[MAST[0], MAST[1], TOWER_H + MAST_H + 4],
]);

benchPlate(s, PLATE);
// The server tower with drive bays on its faces.
s.halo(TOWER, 0);
s.solid(slabOf(TOWER, 0, TOWER_H, s.P, 6, 1));
s.line(planOutline(insetPlan(TOWER, 5), TOWER_H, s.P, 4), { tone: "faint" });
const right = TOWER.x + TOWER.w;
for (let i = 0; i < 4; i++) {
	const z = 10 + i * 9;
	s.line(
		faceRect(s, "x", right, TOWER.y + 8, TOWER.y + TOWER.d - 8, z, z + 6),
		{
			tone: "lo",
		}
	);
}
faceRules(s, "y", TOWER.y + TOWER.d, TOWER.x + 8, 42, [28, 20, 24], 5);
lamp(s, [right - 9, TOWER.y + TOWER.d - 9], TOWER_H, { radius: 1.8 });
// Antenna mast: the server is remote.
s.solid(cylinder(MAST[0], MAST[1], 5, TOWER_H, 2, s.P, 24), { tone: "lo" });
s.solid(cylinder(MAST[0], MAST[1], 1.6, TOWER_H + 2, MAST_H, s.P, 16));
s.solid(cylinder(MAST[0], MAST[1], 3.4, TOWER_H + MAST_H, 3, s.P, 20, 0.4));
// Dock with the sign-in tag, wired to the tower.
s.wire([right, -6, 20], [DOCK.x + 6, DOCK.y + 8, DOCK_H], [[4, -6, 20]]);
s.halo(DOCK, 0);
s.solid(slabOf(DOCK, 0, DOCK_H, s.P, 4, 0.8));
const well = insetPlan(DOCK, 6);
s.line(planOutline(well, DOCK_H, s.P, 3), { tone: "mid" });
screws(
	s,
	[
		[DOCK.x + 4, DOCK.y + DOCK.d - 4],
		[DOCK.x + DOCK.w - 4, DOCK.y + 4],
	],
	DOCK_H,
	1.2
);
const tag = {
	x: well.x + 4,
	y: well.y + 4,
	w: well.w - 8,
	d: well.d - 8,
	r: 3,
};
s.solid(slabOf(tag, DOCK_H - 1, 4, s.P, 4, 0.4), { lit: true });
s.line(ring(tag.x + 7, tag.y + tag.d / 2, 2.4, DOCK_H + 3, s.P, 16), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
