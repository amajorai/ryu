import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRules,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Policy questions: the handbook lies shut on the bench with index tabs for
 * leave, benefits and conduct sticking out of its pages. The answer comes
 * from one section, and its tab (the lit part) is the citation. The slip on
 * the stand beside it holds the employee's question.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const COVER = { x: -74, y: -38, w: 92, d: 74, r: 2 };
const PAGES = {
	x: COVER.x + 2,
	y: COVER.y + 2,
	w: COVER.w - 4,
	d: COVER.d - 4,
	r: 1,
};
const PAGES_TOP = 19;
const TABS: [number, number, boolean][] = [
	[-32, 5, false],
	[-14, 9, false],
	[4, 13, true],
	[20, 7, false],
];
const STAND = { x: 46, y: -18, w: 40, d: 36, r: 4 };
const CARD = { x: 62, y: -14, w: 3, d: 28, r: 0.6 };
const CARD_TOP = 46;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [64, 0, CARD_TOP]]);

benchPlate(s, PLATE);
// The binder: spine, back cover, page block, front cover.
s.halo(COVER, 0);
s.solid(
	slabOf(
		{ x: COVER.x - 6, y: COVER.y, w: 8, d: COVER.d, r: 3 },
		0,
		PAGES_TOP + 3,
		s.P,
		4,
		0.6
	),
	{
		tone: "lo",
	}
);
s.solid(slabOf(COVER, 0, 3, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf(PAGES, 3, PAGES_TOP - 3, s.P, 2), { crease: "none" });
faceRules(
	s,
	"y",
	PAGES.y + PAGES.d,
	PAGES.x + 4,
	PAGES_TOP - 3,
	[80, 80, 80, 80, 80],
	2.6
);
s.solid(slabOf(COVER, PAGES_TOP, 3, s.P, 3, 0.4), { tone: "lo" });
s.line(planOutline(insetPlan(COVER, 8), PAGES_TOP + 3, s.P, 3), {
	tone: "faint",
});
s.solid(
	slabOf(
		{ x: COVER.x + 18, y: COVER.y + 16, w: 40, d: 14, r: 1.5 },
		PAGES_TOP + 3,
		0.8,
		s.P,
		2
	),
	{ crease: "none" }
);
// Index tabs out of the fore edge, one per section.
const fore = PAGES.x + PAGES.w;
for (const [y, z, lit] of byDepth(TABS, s)) {
	s.solid(slabOf({ x: fore - 2, y, w: 16, d: 14, r: 2 }, z, 1.8, s.P, 3), {
		lit,
		crease: "none",
	});
}
// The question slip on its stand.
s.halo(STAND, 0);
s.solid(slabOf(STAND, 0, 7, s.P, 5, 0.8));
screws(
	s,
	[
		[STAND.x + 7, STAND.y + 7],
		[STAND.x + STAND.w - 7, STAND.y + STAND.d - 7],
	],
	7,
	1.4
);
s.solid(
	slabOf(
		{ x: CARD.x - 3, y: CARD.y + 2, w: 9, d: CARD.d - 4, r: 1.5 },
		7,
		5,
		s.P,
		3,
		0.4
	),
	{
		tone: "lo",
	}
);
s.solid(slabOf(CARD, 12, CARD_TOP - 12, s.P, 2), { crease: "none" });
faceRules(
	s,
	"x",
	CARD.x + CARD.w,
	CARD.y + 5,
	CARD_TOP - 7,
	[18, 14, 16, 10],
	6
);

export const drawing = cardDrawing(s);
