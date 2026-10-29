import {
	boxCorners,
	cylinder,
	extrude,
	insetPlan,
	lineOnTop,
	type Plane,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Picks the best server: a three-way selector on the bench. The home server,
 * the cloud cabinet and the phone each sit at one of its stops; the arm is
 * (the lit part) turned to the home server, which is reachable, so it answers.
 */

const PLATE = { x: -104, y: -58, w: 208, d: 116, r: 8 };
const DIAL: Plane = [-2, -4];
const DIAL_R = 32;
const DIAL_H = 6;
const HOME = { x: -90, y: 4, w: 46, d: 40, r: 4 };
const CLOUD = { x: 34, y: -50, w: 40, d: 30, r: 3 };
const CLOUD_H = 46;
const PHONE = { x: 40, y: 12, w: 50, d: 30, r: 6 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CLOUD.x, CLOUD.y, CLOUD_H + 4],
]);

// A point on the dial top toward `target`, `radius` out from its centre.
function toward(target: Plane, radius: number): Plane {
	const dx = target[0] - DIAL[0];
	const dy = target[1] - DIAL[1];
	const length = Math.hypot(dx, dy) || 1;
	return [DIAL[0] + (dx / length) * radius, DIAL[1] + (dy / length) * radius];
}

// A flat bar from the dial centre toward `target`, as a plan ring.
function arm(target: Plane, length: number, width: number): Plane[] {
	const [ex, ey] = toward(target, length);
	const dx = (ex - DIAL[0]) / length;
	const dy = (ey - DIAL[1]) / length;
	const [nx, ny] = [-dy * width, dx * width];
	return [
		[DIAL[0] - dx * 4 + nx, DIAL[1] - dy * 4 + ny],
		[ex + nx, ey + ny],
		[ex - nx, ey - ny],
		[DIAL[0] - dx * 4 - nx, DIAL[1] - dy * 4 - ny],
	];
}

const homeAt: Plane = [HOME.x + HOME.w / 2, HOME.y + HOME.d / 2];
const cloudAt: Plane = [CLOUD.x + CLOUD.w / 2, CLOUD.y + CLOUD.d / 2];
const phoneAt: Plane = [PHONE.x + PHONE.w / 2, PHONE.y + PHONE.d / 2];

benchPlate(s, PLATE);
// Home server: a low box with vents and a power lamp.
s.halo(HOME, 0);
s.solid(slabOf(HOME, 0, 18, s.P, 4, 0.8));
s.line(planOutline(insetPlan(HOME, 4), 18, s.P, 3), { tone: "faint" });
for (let i = 0; i < 4; i++) {
	const y = HOME.y + 10 + i * 4.5;
	s.line(lineOnTop([HOME.x + 8, y], [HOME.x + 30, y], 18, s.P));
}
lamp(s, [HOME.x + HOME.w - 8, HOME.y + 8], 18, { radius: 1.6 });
// Cloud cabinet: a tall rack with drive bays on its face.
s.halo(CLOUD, 0);
s.solid(slabOf(CLOUD, 0, CLOUD_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(CLOUD, 4), CLOUD_H, s.P, 3), { tone: "faint" });
faceRules(
	s,
	"y",
	CLOUD.y + CLOUD.d,
	CLOUD.x + 6,
	CLOUD_H - 8,
	[28, 28, 28, 28, 28, 28],
	6
);
// The selector: a ticked dial, three stop lamps and the turned arm.
s.halo(
	{
		x: DIAL[0] - DIAL_R,
		y: DIAL[1] - DIAL_R,
		w: DIAL_R * 2,
		d: DIAL_R * 2,
		r: DIAL_R,
	},
	0
);
s.solid(cylinder(DIAL[0], DIAL[1], DIAL_R, 0, DIAL_H, s.P, 56, 0.8));
s.line(ring(DIAL[0], DIAL[1], DIAL_R - 4, DIAL_H, s.P, 56), { tone: "faint" });
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	DIAL_R - 4,
	24,
	6,
	DIAL_H,
	[2, 3],
	s.P
);
s.line(ticks.minor, { tone: "faint" });
for (const target of [homeAt, cloudAt, phoneAt]) {
	lamp(s, toward(target, DIAL_R - 3), DIAL_H, { radius: 1.8 });
}
s.solid(extrude(arm(homeAt, DIAL_R - 7, 4), DIAL_H, 3, s.P), { lit: true });
s.solid(cylinder(DIAL[0], DIAL[1], 7, DIAL_H, 7, s.P, 28), { tone: "lo" });
s.line(ring(DIAL[0], DIAL[1], 2.8, DIAL_H + 7, s.P, 16), { tone: "mid" });
// The phone, the last stop, lying screen up.
s.halo(PHONE, 0);
s.solid(slabOf(PHONE, 0, 5, s.P, 8, 0.8), { tone: "hi", crease: "lo" });
s.line(planOutline(insetPlan(PHONE, 3), 5, s.P, 6), { tone: "mid" });
s.line(
	lineOnTop([PHONE.x + 6, PHONE.y + 9], [PHONE.x + 6, PHONE.y + 17], 5, s.P),
	{ tone: "mid" }
);

export const drawing = cardDrawing(s);
