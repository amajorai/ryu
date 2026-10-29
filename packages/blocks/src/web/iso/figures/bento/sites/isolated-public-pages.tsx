import { boxCorners, cylinder, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Isolated public pages: a page on a stand (lit) inside its own walled pen,
 * which is its own address. A crate from another site sits outside the
 * wall: there is no gap for it to come in through.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const PEN = { x0: -76, x1: 28, y0: -44, y1: 44 };
const WALL = 5;
const WALL_H = 16;
const POST_H = 22;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-24, 0, 56]]);

function wall(x: number, y: number, w: number, d: number) {
	const plan = { x, y, w, d, r: 1 };
	s.solid(slabOf(plan, 0, WALL_H, s.P, 3, 0.6));
}

function post(x: number, y: number) {
	s.solid(cylinder(x, y, 4.5, 0, POST_H, s.P, 28, 0.6));
	s.solid(cylinder(x, y, 2.4, POST_H, 2, s.P, 20), { tone: "lo" });
}

benchPlate(s, PLATE);
post(PEN.x0 + WALL / 2, PEN.y0 + WALL / 2);
wall(PEN.x0 + WALL, PEN.y0, PEN.x1 - PEN.x0 - WALL * 2, WALL);
wall(PEN.x0, PEN.y0 + WALL, WALL, PEN.y1 - PEN.y0 - WALL * 2);
post(PEN.x1 - WALL / 2, PEN.y0 + WALL / 2);
post(PEN.x0 + WALL / 2, PEN.y1 - WALL / 2);
// The page on its stand, inside the pen.
const foot = { x: -42, y: -14, w: 36, d: 24, r: 3 };
s.solid(slabOf(foot, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: -28, y: -6, w: 8, d: 6, r: 1 }, 4, 12, s.P, 2));
const page = { x: -50, y: -6, w: 52, d: 5, r: 1 };
s.solid(slabOf(page, 16, 38, s.P, 2, 0.4), { lit: true });
faceRules(s, "y", page.y + page.d, page.x + 5, 48, [34, 40, 28, 36, 22], 5.5);
wall(PEN.x1 - WALL, PEN.y0 + WALL, WALL, PEN.y1 - PEN.y0 - WALL * 2);
wall(PEN.x0 + WALL, PEN.y1 - WALL, PEN.x1 - PEN.x0 - WALL * 2, WALL);
post(PEN.x1 - WALL / 2, PEN.y1 - WALL / 2);
// Another site's crate, left outside the wall.
const crate = { x: 40, y: -14, w: 26, d: 26, r: 2 };
s.halo(crate, 0);
s.solid(slabOf(crate, 0, 18, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: 42, y: -12, w: 22, d: 22, r: 1.5 }, 18, 2, s.P, 3));

export const drawing = cardDrawing(s);
