import {
	boxCorners,
	circleRing,
	cylinder,
	depthOf,
	extrude,
	type Plane,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Switch servers: a heavy rotary selector. Three banks of terminal posts
 * stand round its dial (square posts for your saved servers, round ones for
 * your org's nodes, hexagonal ones for mesh peers); the lever is thrown to
 * one mesh peer, whose cap (the lit part) shows the live connection.
 */

const PLATE = { x: -76, y: -64, w: 152, d: 128, r: 8 };
const DIAL_R = 54;
const DIAL_H = 7;
const POST_R = 41;
const LEVER_Z = 17;

type Bank = "square" | "round" | "hex";
const POSTS: [number, Bank][] = [
	[-148, "square"],
	[-128, "square"],
	[-108, "square"],
	[108, "round"],
	[128, "round"],
	[148, "round"],
	[-24, "hex"],
	[0, "hex"],
	[24, "hex"],
];
const SELECTED = 24;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -POST_R, 34]]);

// The kit's radial convention: angle 0 points to -y.
const polar = (degrees: number, radius: number): Plane => {
	const angle = (degrees * Math.PI) / 180;
	return [Math.sin(angle) * radius, -Math.cos(angle) * radius];
};

function post([degrees, bank]: [number, Bank]) {
	const [x, y] = polar(degrees, POST_R);
	const lit = degrees === SELECTED;
	s.solid(cylinder(x, y, 6, DIAL_H, 1.6, s.P, 24), { tone: "lo" });
	if (bank === "square") {
		s.solid(
			slabOf(
				{ x: x - 4.2, y: y - 4.2, w: 8.4, d: 8.4, r: 0.8 },
				DIAL_H + 1.6,
				14,
				s.P,
				2,
				0.4
			)
		);
	} else if (bank === "round") {
		s.solid(cylinder(x, y, 4.4, DIAL_H + 1.6, 14, s.P, 24, 0.4));
	} else {
		s.solid(
			extrude(circleRing(x, y, 4.8, 6), DIAL_H + 1.6, 14, s.P, { bevel: 0.4 })
		);
	}
	s.solid(cylinder(x, y, lit ? 3.4 : 2.6, DIAL_H + 15.6, 2.4, s.P, 20), {
		lit,
		tone: "lo",
	});
}

function lever() {
	const angle = (SELECTED * Math.PI) / 180;
	const along: Plane = [Math.sin(angle), -Math.cos(angle)];
	const across: Plane = [-along[1], along[0]];
	const point = (t: number, w: number): Plane => [
		along[0] * t + across[0] * w,
		along[1] * t + across[1] * w,
	];
	const arm = [
		point(-8, -5),
		point(POST_R - 7, -2.4),
		point(POST_R - 7, 2.4),
		point(-8, 5),
	];
	s.solid(extrude(arm, LEVER_Z, 3.4, s.P, { bevel: 0.5 }));
	const [hx, hy] = point(POST_R - 15, 0);
	s.solid(cylinder(hx, hy, 2.6, LEVER_Z + 3.4, 8, s.P, 20));
	s.solid(cylinder(hx, hy, 3.6, LEVER_Z + 11.4, 3, s.P, 20, 0.4));
}

benchPlate(s, PLATE);
s.halo({ x: -DIAL_R, y: -DIAL_R, w: DIAL_R * 2, d: DIAL_R * 2, r: DIAL_R }, 0);
s.solid(cylinder(0, 0, DIAL_R, 0, DIAL_H, s.P, 72, 1));
s.line(ring(0, 0, DIAL_R - 4, DIAL_H, s.P, 72), { tone: "faint" });
screws(
	s,
	[polar(-130, DIAL_R - 8), polar(130, DIAL_R - 8), polar(180, DIAL_R - 8)],
	DIAL_H,
	1.4
);
const depth = ([degrees]: [number, Bank]) => {
	const [x, y] = polar(degrees, POST_R);
	return depthOf([x, y, 0], s.P);
};
const hubDepth = depthOf([0, 0, 0], s.P);
const sorted = [...POSTS].sort((a, b) => depth(a) - depth(b));
for (const item of sorted.filter((p) => depth(p) < hubDepth)) {
	post(item);
}
// Hub: a stepped boss under the lever, with the turning knob on top.
s.solid(cylinder(0, 0, 13, DIAL_H, 4, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(0, 0, 9, DIAL_H + 4, LEVER_Z - DIAL_H - 4, s.P, 36));
lever();
knob(s, [0, 0], LEVER_Z + 3.4, 6, 5);
for (const item of sorted.filter((p) => depth(p) >= hubDepth)) {
	post(item);
}

export const drawing = cardDrawing(s);
