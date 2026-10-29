import { boxCorners, cylinder, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Return preparation support: a balance. Last year's return sits in the far
 * pan, this year's work paper in the near one; the beam rides level and the
 * pointer above the pivot (the lit part) stands at zero: the figures agree.
 */

const PLATE = { x: -92, y: -46, w: 184, d: 92, r: 8 };
const FOOT = { x: -18, y: -14, w: 36, d: 28, r: 4 };
const PIVOT = 60;
const ARM = 58;
const PAN_R = 20;
const PAN_Z = 26;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, PIVOT + 22]]);

function hanger(x: number, dx: number, dy: number) {
	s.line(
		`M${s.at([x, 0, PIVOT - 2]).join(",")}L${s.at([x + dx * (PAN_R - 2), dy * (PAN_R - 2), PAN_Z + 3]).join(",")}`,
		{ tone: "mid" }
	);
}

function pan(x: number, sheets: number[]) {
	hanger(x, -1, 0);
	hanger(x, 0, -1);
	// A shallow dish: a narrow foot under a wider rim.
	s.solid(cylinder(x, 0, PAN_R - 7, PAN_Z - 3, 3, s.P, 40), { tone: "lo" });
	s.solid(cylinder(x, 0, PAN_R, PAN_Z, 3, s.P, 48, 0.6));
	sheets.forEach((height, index) => {
		const z = PAN_Z + 3 + index * 3;
		s.solid(
			slabOf(
				{ x: x - 11 + index, y: -8 + index, w: 22, d: 16, r: 1 },
				z,
				height,
				s.P,
				2
			),
			{ crease: "none" }
		);
	});
	hanger(x, 1, 0);
	hanger(x, 0, 1);
	s.solid(cylinder(x, 0, 2.2, PIVOT - 4, 3, s.P, 16), { tone: "lo" });
}

benchPlate(s, PLATE);
pan(-ARM, [2.4, 2.4, 2.4]);
s.halo(FOOT, 0);
s.solid(slabOf(FOOT, 0, 8, s.P, 4, 0.8));
screws(
	s,
	[
		[FOOT.x + 6, FOOT.y + 6],
		[FOOT.x + FOOT.w - 6, FOOT.y + FOOT.d - 6],
	],
	8,
	1.4
);
s.solid(cylinder(0, 0, 7, 8, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(0, 0, 3.6, 11, PIVOT - 13, s.P, 24));
s.solid(
	slabOf(
		{ x: -ARM - 3, y: -3, w: 2 * ARM + 6, d: 6, r: 1.5 },
		PIVOT - 2,
		4,
		s.P,
		3,
		0.4
	)
);
s.solid(cylinder(0, 0, 6, PIVOT - 4, 8, s.P, 28), { tone: "lo" });
s.solid(slabOf({ x: -1, y: -1, w: 2, d: 2, r: 0.4 }, PIVOT + 4, 14, s.P, 2), {
	lit: true,
});
s.solid(cylinder(0, 0, 2.6, PIVOT + 18, 3, s.P, 20), { lit: true });
pan(ARM, [2.4, 2.4]);

export const drawing = cardDrawing(s);
