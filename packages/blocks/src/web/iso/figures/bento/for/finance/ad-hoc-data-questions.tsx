import { boxCorners, sideRing, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Ad hoc data questions: the reporting packs as a row of ring binders between
 * bookends. The answer is marked where it came from: one binder carries an
 * index tab standing out of its pages (lit), the tab the figure is cited to.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const ROW_Y = -30;
const DEPTH = 52;
const WIDTH = 14;
const HEIGHTS = [46, 42, 48, 44, 46, 40];
const CITED = 3;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, ROW_Y, 70]]);

function bookend(x: number) {
	s.solid(slabOf({ x, y: ROW_Y - 2, w: 4, d: DEPTH + 4, r: 1 }, 0, 34, s.P, 2));
	s.solid(
		slabOf({ x: x - 6, y: ROW_Y - 2, w: 16, d: DEPTH + 4, r: 1 }, 0, 2, s.P, 2),
		{ tone: "lo" }
	);
}

function binder(x: number, height: number, cited: boolean) {
	const plan = { x, y: ROW_Y, w: WIDTH, d: DEPTH, r: 1.5 };
	if (cited) {
		s.solid(
			slabOf(
				{ x: x + 3, y: ROW_Y + DEPTH - 22, w: 8, d: 14, r: 1 },
				height - 4,
				20,
				s.P,
				2
			),
			{ lit: true }
		);
	}
	s.solid(slabOf(plan, 0, height, s.P, 3, 0.6));
	const front = ROW_Y + DEPTH;
	s.line(
		faceRect(s, "y", front, x + 3, x + WIDTH - 3, height - 20, height - 6),
		{
			tone: "lo",
		}
	);
	s.line(sideRing([x + WIDTH / 2, front, 12], 3, "y", s.P, 20), {
		tone: "mid",
	});
}

benchPlate(s, PLATE);
s.halo({ x: -78, y: ROW_Y - 2, w: 118, d: DEPTH + 4, r: 2 }, 0);
const start = -66;
bookend(start - 6);
HEIGHTS.forEach((height, i) => {
	binder(start + i * (WIDTH + 2), height, i === CITED);
});
bookend(start + HEIGHTS.length * (WIDTH + 2));
// A note pad on the bench beside the row, the question written down.
const pad = { x: 50, y: 6, w: 30, d: 34, r: 2 };
s.halo(pad, 0);
s.solid(slabOf(pad, 0, 3, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf({ x: 52, y: 9, w: 26, d: 4, r: 1 }, 3, 2, s.P, 2));

export const drawing = cardDrawing(s);
