import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	lineOnTop,
	onTop,
	type Plan,
	planOutline,
	radialTicks,
	ring,
	sideRing,
	slabOf,
} from "../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	ruler,
	screws,
} from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Security: one boundary at each layer of the request path. A request lane runs
 * through a row of gates (network, identity, then the agent-controls checkpoint,
 * isolation, data protection). At the checkpoint a stamp (the lit part) is about
 * to mark the waiting request; a denied request has been switched off onto a
 * spur that ends at a stop block, and every verdict drops a sheet into the audit
 * tray behind. The Secret Vault stands beside the path, by the isolation gate.
 */

const WIDTH = 640;
const HEIGHT = 440;
const PLATE = { x: -140, y: -84, w: 268, d: 152, r: 8 };
const LANE = { x: -130, y: -6, w: 254, d: 26, r: 2 };
const LANE_TOP = 2;
const MID = LANE.y + LANE.d / 2;
/** Gates before and after the checkpoint, in the docs' layer order. */
const GATES_BEFORE = [-108, -80];
const GATES_AFTER = [54, 84];
const GATE_H = 40;
const BOOTH = { x: -42, y: -50, w: 44, d: 34, r: 2.5 };
const BOOTH_H = 62;
const STAMP_X = -20;
const SPUR = { x: 20, y: LANE.y + LANE.d - 2, w: 18, d: 38, r: 1.5 };
const STOP = { x: 18, y: SPUR.y + SPUR.d, w: 22, d: 7, r: 1.5 };
const TRAY = { x: 50, y: -76, w: 62, d: 40, r: 3 };
const VAULT = { x: 58, y: 30, w: 40, d: 28, r: 2.5 };
const VAULT_H = 32;
const TOKEN = 14;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BOOTH.x, BOOTH.y, BOOTH_H + 10]],
	WIDTH,
	HEIGHT
);

const tokenPlan = (x: number, y = MID): Plan => ({
	x: x - TOKEN / 2,
	y: y - TOKEN / 2,
	w: TOKEN,
	d: TOKEN,
	r: 1.5,
});

/** A request on the lane; `mark` is what its top carries after a verdict. */
function token(x: number, y: number, mark?: "stamped" | "denied") {
	const plan = tokenPlan(x, y);
	const top = LANE_TOP + 7;
	s.solid(slabOf(plan, LANE_TOP, 7, s.P, 3, 0.5), {
		tone: mark === "denied" ? "lo" : "mid",
	});
	if (mark === "stamped") {
		s.line(ring(x, y, 3.4, top, s.P, 28), { tone: "hi" });
	}
	if (mark === "denied") {
		s.line(
			lineOnTop([x - 3.5, y - 3.5], [x + 3.5, y + 3.5], top, s.P) +
				lineOnTop([x - 3.5, y + 3.5], [x + 3.5, y - 3.5], top, s.P),
			{ tone: "hi" }
		);
	}
}

/** One post of a gate frame. */
function post(x: number, y: number) {
	s.solid(slabOf({ x: x - 2, y, w: 4, d: 4, r: 0.6 }, 0, GATE_H, s.P, 2), {
		crease: "none",
	});
}

/** A gate's front post and lintel; its back post goes in before the lane. */
function gateFront(x: number) {
	post(x, LANE.y + LANE.d + 1);
	const lintel = {
		x: x - 2.5,
		y: LANE.y - 5,
		w: 5,
		d: LANE.d + 10,
		r: 0.8,
	};
	s.solid(slabOf(lintel, GATE_H, 4, s.P, 3, 0.4));
	s.line(
		lineOnTop([x, lintel.y + 3], [x, lintel.y + lintel.d - 3], GATE_H + 4, s.P),
		{ tone: "faint" }
	);
}

function auditTray() {
	s.halo(TRAY, 0);
	s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
	s.line(planOutline(insetPlan(TRAY, 2.5), 5, s.P, 3), { tone: "mid" });
	for (let i = 0; i < 4; i++) {
		const sheet = {
			x: TRAY.x + 7 + i * 1.2,
			y: TRAY.y + 6 - i * 0.9,
			w: TRAY.w - 16,
			d: TRAY.d - 12,
			r: 0.6,
		};
		const z = 3 + i * 1.6;
		s.solid(slabOf(sheet, z, 1, s.P, 2), { crease: "none" });
		if (i === 3) {
			[30, 38, 22, 34].forEach((width, row) => {
				const y = sheet.y + 6 + row * 5;
				s.line(
					lineOnTop([sheet.x + 5, y], [sheet.x + 5 + width, y], z + 1, s.P),
					{
						tone: row === 0 ? "mid" : "faint",
					}
				);
			});
		}
	}
}

function booth() {
	s.halo(BOOTH, 0);
	s.solid(slabOf(insetPlan(BOOTH, -1.5), 0, 4, s.P, 3, 0.6), { tone: "lo" });
	s.solid(slabOf(BOOTH, 4, BOOTH_H - 4, s.P, 3, 1));
	screws(s, corners(BOOTH, 4), BOOTH_H, 1.2);
	const face = BOOTH.y + BOOTH.d;
	s.line(faceRect(s, "y", face, BOOTH.x + 24, BOOTH.x + BOOTH.w - 4, 10, 36), {
		tone: "mid",
	});
	faceRules(s, "y", face, BOOTH.x + 27, 31, [9, 12, 7, 10], 5);
	lamp(s, [BOOTH.x + BOOTH.w - 9, BOOTH.y + 8], BOOTH_H);
	lamp(s, [BOOTH.x + BOOTH.w - 17, BOOTH.y + 8], BOOTH_H);
}

/** The stamp hangs from an arm over the lane, just above the waiting request. */
function stamp() {
	const head = LANE_TOP + 7 + 8;
	const arm = {
		x: STAMP_X - 4,
		y: BOOTH.y + 6,
		w: 8,
		d: MID - BOOTH.y,
		r: 1.2,
	};
	s.solid(cylinder(STAMP_X, MID, 6, head, 5, s.P, 32, 0.6), { lit: true });
	s.solid(
		cylinder(STAMP_X, MID, 1.8, head + 5, BOOTH_H + 4 - head - 5, s.P, 16),
		{
			crease: "none",
		}
	);
	s.solid(slabOf(arm, BOOTH_H + 2, 6, s.P, 3, 0.5));
	s.line(ring(STAMP_X, MID, 2.2, BOOTH_H + 8, s.P, 16), { tone: "mid" });
}

/** The spur a denied request is switched onto, ending at a stop block. */
function spur() {
	s.solid(slabOf(SPUR, 0, LANE_TOP, s.P, 2), { tone: "lo", crease: "none" });
	s.line(
		onTop(
			[
				[STAMP_X + 8, MID],
				[SPUR.x + SPUR.w / 2, MID],
				[SPUR.x + SPUR.w / 2, SPUR.y + SPUR.d - 16],
			],
			LANE_TOP + 0.1,
			s.P
		),
		{ dotted: true, tone: "mid" }
	);
	token(SPUR.x + SPUR.w / 2, SPUR.y + SPUR.d - 10, "denied");
	s.solid(slabOf(STOP, 0, 10, s.P, 3, 0.6));
	s.line(
		lineOnTop(
			[STOP.x + 3, STOP.y + 3.5],
			[STOP.x + STOP.w - 3, STOP.y + 3.5],
			10,
			s.P
		),
		{ tone: "mid" }
	);
}

/** The Secret Vault beside the path: a safe with a combination dial and handle. */
function vault() {
	s.halo(VAULT, 0);
	s.solid(slabOf(VAULT, 0, VAULT_H, s.P, 4, 1));
	screws(s, corners(VAULT, 4), VAULT_H, 1.1);
	const face = VAULT.y + VAULT.d;
	s.line(
		faceRect(s, "y", face, VAULT.x + 3, VAULT.x + VAULT.w - 3, 3, VAULT_H - 3),
		{
			tone: "mid",
		}
	);
	s.line(sideRing([VAULT.x + 14, face, 13], 6, "y", s.P, 32), { tone: "mid" });
	s.line(sideRing([VAULT.x + 14, face, 13], 2, "y", s.P, 16), { tone: "lo" });
	s.line(faceRect(s, "y", face, VAULT.x + 26, VAULT.x + 28, 8, 18), {
		tone: "hi",
	});
	const [cx, cy] = [VAULT.x + VAULT.w - 9, VAULT.y + 9];
	const ticks = radialTicks(cx, cy, 5, 24, 6, VAULT_H, [0.8, 1.6], s.P);
	s.line(ticks.minor, { tone: "faint" });
	s.line(ticks.major);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 100, d: 7, r: 1 });
auditTray();
s.wire(
	[BOOTH.x + BOOTH.w, BOOTH.y + 10, 20],
	[TRAY.x, TRAY.y + TRAY.d / 2, 3],
	[
		[BOOTH.x + BOOTH.w + 8, BOOTH.y + 10, 0.8],
		[BOOTH.x + BOOTH.w + 8, TRAY.y + TRAY.d / 2, 0.8],
	],
	{ flow: true }
);
booth();
for (const x of [...GATES_BEFORE, ...GATES_AFTER]) {
	post(x, LANE.y - 5);
}
s.solid(slabOf(LANE, 0, LANE_TOP, s.P, 3), { tone: "lo", crease: "none" });
s.line(
	lineOnTop(
		[LANE.x + 4, MID],
		[LANE.x + LANE.w - 4, MID],
		LANE_TOP + 0.05,
		s.P
	),
	{ dotted: true, tone: "faint" }
);
for (const x of GATES_BEFORE) {
	gateFront(x);
}
token(-56, MID);
token(STAMP_X, MID);
stamp();
spur();
for (const x of GATES_AFTER) {
	gateFront(x);
}
token(108, MID, "stamped");
vault();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
