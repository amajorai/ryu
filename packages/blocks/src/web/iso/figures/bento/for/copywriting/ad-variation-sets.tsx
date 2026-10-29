import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { along, turnedSlab } from "./turned.ts";

/*
 * Ad variation sets: a swatch fan. One brief is the pivot; five headline
 * cards swing out from it at different angles. Beside it, an A/B sorting tray
 * holds two picked cards, the one going out to test (the lit card) in front.
 */

const PLATE = { x: -100, y: -58, w: 200, d: 112, r: 8 };
const PIVOT: [number, number] = [-22, 34];
const LENGTH = 82;
const CARD_W = 17;
const ANGLES = [-145, -117, -90, -63, -35].map((deg) => (deg * Math.PI) / 180);
const TRAY = { x: 52, y: -38, w: 40, d: 72, r: 4 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 26]]);

benchPlate(s, PLATE);
// The brief: a round base the fan pivots on.
s.halo({ x: PIVOT[0] - 16, y: PIVOT[1] - 16, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(PIVOT[0], PIVOT[1], 15, 0, 5, s.P, 36, 0.6), { tone: "lo" });
ANGLES.forEach((angle, index) => {
	const z = 5 + index * 2.6;
	s.solid(turnedSlab(PIVOT, angle, [-8, LENGTH], CARD_W, z, 2, s.P), {
		crease: "none",
	});
	const top = z + 2;
	s.line(
		lineOnTop(
			along(PIVOT, angle, 18),
			along(PIVOT, angle, LENGTH - 6),
			top,
			s.P
		),
		{ tone: "mid" }
	);
});
// The rivet that holds the fan together.
s.solid(cylinder(PIVOT[0], PIVOT[1], 5, 5, 15, s.P, 24), { tone: "lo" });
s.solid(cylinder(PIVOT[0], PIVOT[1], 6.5, 20, 2, s.P, 28));
// A/B tray: a shallow box with a divider, one card in each half.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 6, 0.8));
s.line(planOutline(insetPlan(TRAY, 4), 5, s.P, 4), { tone: "faint" });
const card = (y: number, lit: boolean) =>
	s.solid(
		slabOf({ x: TRAY.x + 7, y, w: TRAY.w - 14, d: 22, r: 2 }, 5, 2.4, s.P, 3),
		{
			lit,
			tone: "lo",
		}
	);
card(TRAY.y + 7, false);
s.solid(
	slabOf({ x: TRAY.x + 3, y: -2, w: TRAY.w - 6, d: 3, r: 1 }, 5, 7, s.P, 2)
);
card(TRAY.y + 41, true);
screws(
	s,
	[
		[TRAY.x + TRAY.w - 4, TRAY.y + 4],
		[TRAY.x + 4, TRAY.y + TRAY.d - 4],
	],
	5,
	1.4
);

export const drawing = cardDrawing(s);
