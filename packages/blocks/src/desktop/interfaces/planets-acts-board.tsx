/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { type RefObject, useRef } from "react";
import type { Group } from "three";
import { pipCounts } from "./game3d-meters.tsx";
import { type ActSim, screenPoint, type Vec3 } from "./planets-acts-layout.ts";
import { tint } from "./planets-acts-station.tsx";
import {
	FOV,
	MOON_TILTS,
	type Moon,
	moonSpeed,
	type Planet,
} from "./planets-model.ts";
import { moonKey } from "./planets-overlay.tsx";
import { PLANETS_ACT } from "./planets-palette.ts";

/** The Planets act layer's progress arc and board placement (see planets-acts.tsx). */

const PIP_PX = 4.5;
/** Clear space between pips along the arc, px. */
const PIP_SPACING_PX = 4;
/** Clear space between the moon's rim and the arc, px. */
const ARC_GAP_PX = 7;
/** The arc's sweep over the top of the moon (radians). */
const ARC_SWEEP = Math.PI * 0.8;

/** World units per screen pixel at `depth` in front of the camera. */
export function worldPerPx(depth: number, height: number): number {
	return (
		(2 * Math.max(0.1, depth) * Math.tan(((FOV / 2) * Math.PI) / 180)) /
		Math.max(1, height)
	);
}

/** The progress arc's pips for `act` (0 when it draws none). */
export function arcPipCount(act: InterfaceAgentAct, planet: Planet): number {
	const progress = act.progress;
	const moon = planet.moons.some((item) => item.threadId === act.threadId);
	if (!(moon && progress) || progress.total <= 0) {
		return 0;
	}
	return progress.kind === "estimate" ? 8 : pipCounts(progress).count;
}

/** How far the arc's pips stand from the moon's centre, px. */
function arcReachPx(count: number, moonPx: number): number {
	const spread =
		(Math.max(1, count - 1) * (2 * PIP_PX + PIP_SPACING_PX)) / ARC_SWEEP;
	return Math.max(moonPx + ARC_GAP_PX + PIP_PX, spread);
}

/**
 * The plan's progress as an arc of pips over the focus moon (the act's
 * thread): done pips lit, the rest dim; an estimate fills its share. The
 * pips keep a readable size on screen however small the moon is drawn (the
 * overview), and the arc opens wide enough to keep them apart.
 */
export function ProgressArc({
	act,
	azimuth,
	column,
	planet,
	sim,
}: {
	act: InterfaceAgentAct;
	azimuth: number;
	column: boolean;
	planet: Planet;
	sim: RefObject<ActSim>;
}) {
	const group = useRef<Group>(null);
	const moon = planet.moons.find((item) => item.threadId === act.threadId);
	const progress = act.progress;
	const estimate = progress?.kind === "estimate";
	const counts =
		progress && !estimate ? pipCounts(progress) : { count: 8, filled: 0 };
	const count = counts.count;
	useFrame(({ camera, size }) => {
		const node = group.current;
		const body = moon
			? sim.current.moonGroups.get(moonKey(planet.id, moon.threadId))
			: undefined;
		if (!(node && body && moon) || size.height <= 0) {
			return;
		}
		body.getWorldPosition(node.position);
		// One unit inside the group is one pixel on screen at the moon.
		const perPx = worldPerPx(
			camera.position.distanceTo(node.position),
			size.height
		);
		node.scale.setScalar(perPx);
		const moonPx = (moon.radius * sim.current.bodyScale) / perPx;
		const reach = arcReachPx(count, moonPx);
		for (const [index, pip] of node.children.entries()) {
			// Over the top of the moon, left to right as the screen reads.
			const angle =
				Math.PI / 2 +
				ARC_SWEEP / 2 -
				(index / Math.max(1, count - 1)) * ARC_SWEEP;
			pip.position.set(
				...screenPoint(
					azimuth,
					column,
					Math.cos(angle) * reach,
					Math.sin(angle) * reach,
					// Toward the camera, so the moon never hides its own arc.
					moonPx
				)
			);
		}
	}, -1);
	if (!(moon && progress) || progress.total <= 0) {
		return null;
	}
	const filled = estimate
		? Math.floor((progress.done / progress.total) * count)
		: counts.filled;
	return (
		<group ref={group}>
			{Array.from({ length: count }, (_, index) => (
				<mesh
					// biome-ignore lint/suspicious/noArrayIndexKey: pips are positional.
					key={index}
					scale={PIP_PX}
				>
					<sphereGeometry args={[1, 10, 8]} />
					{tint(index < filled ? PLANETS_ACT.pipDone : PLANETS_ACT.pipTodo)}
				</mesh>
			))}
		</group>
	);
}

/** The station board's usual height over its planet (planet radii). */
export const BOARD_LIFT = 1.75;
/** One row of the board (a status plate and its gap), px. */
const BOARD_ROW_PX = 26;
/** A row's width per character and its padding, px (a little generous). */
const BOARD_CHAR_PX = 6.6;
const BOARD_PAD_PX = 22;
/** Clear space round the board, px. */
const BOARD_GAP_PX = 6;
/** Clear space between the board and a progress arc's pips, px (the pips stand a little toward the camera). */
const BOARD_ARC_GAP_PX = 10;
/** The board moves in steps of this much (planet radii), so it rarely moves. */
export const BOARD_STEP = 0.25;
/** How far ahead along its orbit the focus moon is watched (seconds). */
export const ARC_HORIZON = 6;
const ARC_SAMPLES = 8;
/** A planet's alarms stand this far to its right (planet radii; see the layout). */
const ALARM_RIGHT = 1.45;
/** Half an icon-only alarm's width, px. */
const ALARM_HALF_PX = 18;
/** Clear space between a phone's board and the scene's right edge, px. */
export const SCENE_EDGE_PX = 8;

/**
 * A box on screen round a planet's centre, px (x right, y up), such as
 * where the focus moon and its progress arc stand.
 */
export interface ArcSpan {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** A station board's size on screen, px, for its status words. */
export function boardSize(lines: readonly { text: string }[]): {
	height: number;
	width: number;
} {
	let chars = 0;
	for (const line of lines) {
		chars = Math.max(chars, line.text.length);
	}
	return {
		height: lines.length * BOARD_ROW_PX,
		width: chars * BOARD_CHAR_PX + BOARD_PAD_PX,
	};
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where the focus moon and each pip of its progress arc stand on screen
 * (boxes, px from the planet's centre), now and over the next few seconds
 * of its orbit (the moon first, then its pips, for each moment), from
 * its current offset (`offset`, world units before the swell). `right` and
 * `up` are the screen's axes in the world; `horizon` is how far ahead to
 * look (0 for a moon that holds still).
 */
export function arcSpans({
	horizon = ARC_HORIZON,
	moon,
	offset,
	perPx,
	pips,
	right,
	scale,
	up,
}: {
	horizon?: number;
	moon: Pick<Moon, "orbit" | "radius" | "shell">;
	offset: Vec3;
	perPx: number;
	pips: number;
	right: Vec3;
	scale: number;
	up: Vec3;
}): ArcSpan[] {
	const tilt = MOON_TILTS[moon.shell === 0 ? 0 : 1];
	const start = Math.atan2(offset[2] / Math.cos(tilt), offset[0]);
	const toPx = scale / Math.max(1e-6, perPx);
	const moonPx = moon.radius * toPx;
	const reach = arcReachPx(pips, moonPx);
	const samples = horizon > 0 ? ARC_SAMPLES : 0;
	const spans: ArcSpan[] = [];
	for (let index = 0; index <= samples; index += 1) {
		const angle =
			start + (moonSpeed(moon) * horizon * index) / Math.max(1, samples);
		const flat = Math.sin(angle) * moon.orbit;
		const point: Vec3 = [
			Math.cos(angle) * moon.orbit,
			flat * Math.sin(tilt),
			flat * Math.cos(tilt),
		];
		const x = dot(right, point) * toPx;
		const y = dot(up, point) * toPx;
		spans.push({
			bottom: y - moonPx,
			left: x - moonPx,
			right: x + moonPx,
			top: y + moonPx,
		});
		// Each pip, as `ProgressArc` lays them over the top of the moon.
		for (let pip = 0; pip < pips; pip += 1) {
			const turn =
				Math.PI / 2 + ARC_SWEEP / 2 - (pip / Math.max(1, pips - 1)) * ARC_SWEEP;
			const pipX = x + Math.cos(turn) * reach;
			const pipY = y + Math.sin(turn) * reach;
			spans.push({
				bottom: pipY - PIP_PX,
				left: pipX - PIP_PX,
				right: pipX + PIP_PX,
				top: pipY + PIP_PX,
			});
		}
	}
	return spans;
}

/** True when two boxes (px, y up) come within `gap` of each other. */
function meets(a: ArcSpan, b: ArcSpan, gap: number): boolean {
	return (
		a.left < b.right + gap &&
		b.left < a.right + gap &&
		a.bottom < b.top + gap &&
		b.bottom < a.top + gap
	);
}

/**
 * The board's lift over its planet (planet radii) in the overview: its
 * column of status words (`size`, px) stands clear of the world and of
 * the focus moon's progress arc where it stands now and soon (`arcs`), and
 * no higher than that, since the rows are a fixed height on screen and the
 * world is not. An arc off to the side of the board does not lift it.
 */
export function boardLift({
	arcs,
	planetPx,
	size,
}: {
	arcs: readonly ArcSpan[];
	planetPx: number;
	size: { height: number; width: number };
}): number {
	const radius = Math.max(1, planetPx);
	const half = size.height / 2;
	let centre = Math.max(BOARD_LIFT * radius, radius + BOARD_GAP_PX + half);
	// Each pass steps over the arc in the way; arcs are few, so it ends soon.
	for (let pass = 0; pass <= arcs.length; pass += 1) {
		const board: ArcSpan = {
			bottom: centre - half,
			left: -size.width / 2,
			right: size.width / 2,
			top: centre + half,
		};
		const hit = arcs.find((arc) => meets(board, arc, BOARD_ARC_GAP_PX));
		if (!hit) {
			break;
		}
		centre = hit.top + BOARD_ARC_GAP_PX + half;
	}
	const lift = Math.ceil(centre / radius / BOARD_STEP) * BOARD_STEP;
	return Math.max(BOARD_LIFT, lift);
}

/**
 * Where a phone's board stands beside its planet (planet radii to the
 * right of its centre, level with it), when it is too tall to stand over
 * the planet: a column of planets has no room above a world (the next one
 * stands there), and the station strip takes the left, so the board goes
 * right, past the planet, its alarms (`alarms`) and the focus moon's arc,
 * within `room` px of the centre.
 */
export function boardBeside({
	alarms,
	arcs,
	planetPx,
	room,
	size,
}: {
	alarms: boolean;
	arcs: readonly ArcSpan[];
	planetPx: number;
	room: number;
	size: { height: number; width: number };
}): number {
	const radius = Math.max(1, planetPx);
	const half = size.height / 2;
	const first =
		Math.max(radius, alarms ? ALARM_RIGHT * radius + ALARM_HALF_PX : 0) +
		BOARD_GAP_PX;
	let left = first;
	for (let pass = 0; pass <= arcs.length; pass += 1) {
		const board: ArcSpan = {
			bottom: -half,
			left,
			right: left + size.width,
			top: half,
		};
		const hit = arcs.find((arc) => meets(board, arc, BOARD_ARC_GAP_PX));
		if (!hit) {
			break;
		}
		left = hit.right + BOARD_ARC_GAP_PX;
	}
	// Short of room, the board keeps to the scene (past the planet if it can).
	left = Math.max(first, Math.min(left, room - size.width));
	const centre = left + size.width / 2;
	return Math.ceil(centre / radius / BOARD_STEP) * BOARD_STEP;
}
