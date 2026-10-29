import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Injection and leaks: a leak-test rig. An injector on a gantry arm pushes
 * into the sealed canister's inlet port, a pressure gauge watches the lid, and
 * whatever escapes runs out of the drain spout into the catch tray in front
 * (the lit puddle): the leak the test exists to find.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const C: [number, number] = [-22, -6];
const R = 26;
const BODY_H = 32;
const LID = BODY_H + 3;
const PORT: [number, number] = [C[0] + 9, C[1] - 4];
const POST = { x: PORT[0] - 6, y: -50, w: 12, d: 12, r: 2 };
const ARM_Z = 60;
const TOP = 76;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PORT[0], PORT[1], TOP],
	[POST.x, POST.y, ARM_Z + 6],
]);

benchPlate(s, PLATE);
// Gantry post behind the canister.
s.halo(POST, 0);
s.solid(slabOf(POST, 0, ARM_Z, s.P, 4, 0.8));
// The sealed canister: base collar, body with a gasket band, bolted lid.
s.halo(
	{ x: C[0] - R - 3, y: C[1] - R - 3, w: 2 * R + 6, d: 2 * R + 6, r: R + 3 },
	0
);
s.solid(cylinder(C[0], C[1], R + 3, 0, 3, s.P, 48, 0.6), { tone: "lo" });
s.solid(cylinder(C[0], C[1], R, 3, 12, s.P, 48));
s.solid(cylinder(C[0], C[1], R + 1.6, 15, 3, s.P, 48), { tone: "lo" });
s.solid(cylinder(C[0], C[1], R, 18, BODY_H - 18, s.P, 48, 0.8));
s.solid(cylinder(C[0], C[1], R - 2, BODY_H, 3, s.P, 48, 0.6));
const bolts = Array.from({ length: 8 }, (_, i): [number, number] => {
	const a = (i / 8) * Math.PI * 2 + 0.2;
	return [C[0] + Math.cos(a) * (R - 6), C[1] + Math.sin(a) * (R - 6)];
});
screws(s, bolts, LID, 1.3);
// Pressure gauge on the lid.
const G: [number, number] = [C[0] - 9, C[1] + 8];
s.solid(cylinder(G[0], G[1], 7, LID, 4, s.P, 32, 0.4));
const ticks = radialTicks(G[0], G[1], 6, 12, 3, LID + 4, [1, 2], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
// Inlet port, needle and injector barrel hanging from the arm.
s.solid(cylinder(PORT[0], PORT[1], 4.5, LID, 4, s.P, 24), { tone: "lo" });
s.solid(cylinder(PORT[0], PORT[1], 0.9, LID + 4, 6, s.P, 12));
s.solid(cylinder(PORT[0], PORT[1], 3, LID + 10, 3, s.P, 20), { tone: "lo" });
s.solid(cylinder(PORT[0], PORT[1], 5.5, LID + 13, ARM_Z - LID - 13, s.P, 28));
s.line(ring(PORT[0], PORT[1], 5.5, LID + 19, s.P, 28), { tone: "faint" });
s.solid(
	slabOf(
		{ x: PORT[0] - 5, y: POST.y + 1, w: 10, d: PORT[1] - POST.y + 5, r: 1.5 },
		ARM_Z,
		6,
		s.P,
		3,
		0.6
	)
);
// Plunger rod and thumb pad above the arm.
s.solid(cylinder(PORT[0], PORT[1], 1.6, ARM_Z + 6, 7, s.P, 16));
s.solid(cylinder(PORT[0], PORT[1], 6, ARM_Z + 13, 3, s.P, 28, 0.4));
// Drain spout out of the canister's side, over the catch tray.
const TRAY = { x: 14, y: -12, w: 50, d: 38, r: 4 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 6, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(TRAY, 4), 5, s.P, 4), { tone: "faint" });
s.solid(slabOf({ x: 22, y: 0, w: 22, d: 16, r: 7 }, 5, 2, s.P, 6), {
	lit: true,
	crease: "none",
});
s.solid(slabOf({ x: C[0] + R - 2, y: 3, w: 30, d: 5, r: 1.5 }, 10, 4, s.P, 3));
s.solid(cylinder(C[0] + R + 6, 5.5, 3, 14, 3, s.P, 20), { tone: "lo" });
// Control pod at the front left.
const POD = { x: -76, y: 26, w: 40, d: 20, r: 3 };
s.halo(POD, 0);
s.solid(slabOf(POD, 0, 8, s.P, 4, 0.6));
knob(s, [POD.x + 10, POD.y + 10], 8, 4, 4);
knob(s, [POD.x + 22, POD.y + 10], 8, 4, 4);
lamp(s, [POD.x + 33, POD.y + 10], 8, { radius: 1.8 });

export const drawing = cardDrawing(s);
