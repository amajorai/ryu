import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Query explanation: a fitting taken apart. The assembled valve stands at the
 * back; its pieces lie laid out in the compartments of a parts tray in front,
 * the tee joint, the gear, the spacer, the nut and the filter screen (the lit
 * part), each in its own bay so you can see what it does.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const VALVE: [number, number] = [-70, -30];
const TRAY = { x: -46, y: -38, w: 132, d: 80, r: 4 };
const TRAY_H = 7;
const FLOOR = 2;
const BAY_W = TRAY.w / 3;
const BAY_D = TRAY.d / 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-70, -30, 52]]);

const bay = (col: number, row: number): [number, number] => [
	TRAY.x + BAY_W * (col + 0.5),
	TRAY.y + BAY_D * (row + 0.5),
];

benchPlate(s, PLATE);
// The assembled valve: flange, body, filter housing, cap.
s.halo({ x: -86, y: -46, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(...VALVE, 15, 0, 4, s.P, 36, 0.4), { tone: "lo" });
s.solid(cylinder(...VALVE, 10, 4, 18, s.P, 32));
s.solid(cylinder(...VALVE, 13, 22, 10, s.P, 36, 0.6));
s.solid(cylinder(...VALVE, 8, 32, 14, s.P, 28));
s.solid(cylinder(...VALVE, 10, 46, 4, s.P, 6, 0.4), { tone: "lo" });
screws(s, [[VALVE[0] - 11, VALVE[1] + 11]], 4, 1.2);
// The parts tray and its dividers.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8), { tone: "lo" });
s.line(
	lineOnTop(
		[TRAY.x + 3, TRAY.y + BAY_D],
		[TRAY.x + TRAY.w - 3, TRAY.y + BAY_D],
		TRAY_H,
		s.P
	),
	{ tone: "mid" }
);
for (const col of [1, 2]) {
	const x = TRAY.x + BAY_W * col;
	s.line(lineOnTop([x, TRAY.y + 3], [x, TRAY.y + TRAY.d - 3], TRAY_H, s.P), {
		tone: "mid",
	});
}
// Back row: tee joint, gear, spacer.
const [tx, ty] = bay(0, 0);
s.solid(
	slabOf(
		{ x: tx - 15, y: ty - 4, w: 30, d: 8, r: 3 },
		FLOOR + 3,
		7,
		s.P,
		4,
		0.4
	)
);
s.solid(
	slabOf({ x: tx - 4, y: ty - 4, w: 8, d: 16, r: 3 }, FLOOR + 3, 7, s.P, 4, 0.4)
);
const [gx, gy] = bay(1, 0);
s.solid(cylinder(gx, gy, 12, TRAY_H - 2, 4, s.P, 40, 0.4));
const teeth = radialTicks(gx, gy, 12, 20, 5, TRAY_H + 2, [2.5, 2.5], s.P);
s.line(teeth.minor + teeth.major, { tone: "lo" });
s.line(ring(gx, gy, 3, TRAY_H + 2, s.P, 20), { tone: "mid" });
const [px, py] = bay(2, 0);
s.solid(cylinder(px, py, 9, TRAY_H - 2, 7, s.P, 32, 0.4));
s.line(ring(px, py, 5, TRAY_H + 5, s.P, 24), { tone: "lo" });
// Front row: nut, filter screen, a short pipe.
const [nx, ny] = bay(0, 1);
s.solid(cylinder(nx, ny, 10, TRAY_H - 2, 6, s.P, 6, 0.4), { tone: "lo" });
s.line(ring(nx, ny, 4.5, TRAY_H + 4, s.P, 20), { tone: "mid" });
const [fx, fy] = bay(1, 1);
const screen = { x: fx - 14, y: fy - 14, w: 28, d: 28, r: 14 };
s.solid(cylinder(fx, fy, 14, TRAY_H - 2, 3, s.P, 40, 0.4), { lit: true });
for (const dx of [-8, -4, 0, 4, 8]) {
	const half = Math.sqrt(11 * 11 - dx * dx);
	s.line(
		lineOnTop([fx + dx, fy - half], [fx + dx, fy + half], TRAY_H + 1, s.P),
		{
			tone: "lo",
		}
	);
}
s.line(ring(fx, fy, insetPlan(screen, 3).r, TRAY_H + 1, s.P, 40), {
	tone: "lo",
});
const [qx, qy] = bay(2, 1);
s.solid(cylinder(qx, qy, 7, TRAY_H - 2, 14, s.P, 28, 0.4));
s.line(ring(qx, qy, 4.5, TRAY_H + 12, s.P, 24), { tone: "lo" });

export const drawing = cardDrawing(s);
