/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceAskKind,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	CircleHelp,
	Keyboard,
	KeyRound,
	type LucideIcon,
	Package,
	ShieldCheck,
} from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Group, Vector3 } from "three";
import {
	ActStation,
	type LimitText,
	type StationLayout,
	stationLines,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actorTarget,
	isRedBlocker,
	type OffStage,
	slotOf,
	YOU_SLOTS,
	YOU_SPOT,
	YOU_TRAY,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { pipCounts, queuePlateText, timerLevel } from "./game3d-meters.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import {
	COLUMN_ELEVATION,
	FOV,
	MOON_TILTS,
	type Moon,
	moonSpeed,
	type Planet,
	type PlanetSystem,
} from "./planets-model.ts";
import { moonKey } from "./planets-overlay.tsx";
import { PLANETS_ACT } from "./planets-palette.ts";

/**
 * The Planets act layer in the canvas (spec §5 planets row). A space station
 * with four berths hangs in the foreground, held at the same place on
 * screen whatever the camera does: an asking agent's probe launches from
 * its planet and docks in its berth, where a ring light drains with the
 * wait; a ready answer waits as a cargo capsule (blinking while unread,
 * steady under reduced motion). At each planet: a red storm band for a
 * failed run, a dark moon for an interrupted one, an eclipse with "Back
 * 15:10" for a limit, a satellite on an orbit marker while it works, and
 * the kit's station (alarms, unread, suggestions, the status board). An arc
 * of pips round the focus moon (the act's thread) shows the plan's
 * progress. Every in-scene plate is a pointer target only (tabIndex -1):
 * the planet list and the ask queue carry the keyboard (a list game).
 */

type Vec3 = [number, number, number];

/** What the act layer reads from the scene's simulation, each frame. */
export interface ActSim {
	/** The bodies' drawn scale (the overview swell). */
	bodyScale: number;
	moonGroups: Map<string, Group>;
	/** Each planet's centre. */
	positions: Map<string, Vec3>;
	time: number;
}

/** The answer capsule is the planets' deliverable; asks carry no letter. */
export const PLANETS_SKIN: ActSkin = {
	deliverable: {
		accent: PLANETS_ACT.capsuleBand,
		color: PLANETS_ACT.capsule,
		shape: "box",
	},
};

/** "Back 15:10": the eclipse's words (the kit adds "Likely"). */
export const planetsLimitText: LimitText = (_act, at) =>
	at ? `Back ${at}` : "Eclipsed";

/** Each ask kind's satellite: its plate icon and its probe colour. */
export const PROBE_ICONS: Record<InterfaceAskKind, LucideIcon> = {
	approval: ShieldCheck,
	input: Keyboard,
	permission: KeyRound,
	question: CircleHelp,
	reply: Package,
};

/** Pixels per station unit: the station is drawn at a fixed screen size. */
export const STATION_UNIT_PX = 40;
/** How far in front of the camera the station hangs (world units). */
const STATION_DEPTH = 12;
/** Narrower than this, the berths stand two by two. */
export const STATION_NARROW = 640;
/** How far the queue plates float above their berths (station units). */
const PLATE_LIFT = 1.1;
const BERTH_GAP = 3.3;
/** A phone's berths stand one above another, a plate and a ring apart. */
const STRIP_GAP = 2.25;
/** A phone's strip: its centre's distance from the scene's left edge (px). */
const STRIP_INSET = 58;
/** A phone's strip: the top berth's height above the scene's bottom (px). */
const STRIP_TOP = 460;

/**
 * The station's layout in its own units (STATION_UNIT_PX each, x right and
 * y up on screen): four berths in a row (two by two on a narrow stage, one
 * above another down the left edge beside a phone's column of planets),
 * the capsule's cargo bay, the tallies, and where the station's origin
 * sits on screen (`anchor`, px from the scene's bottom-right corner).
 */
export function stationLayout(
	width: number,
	column = false
): {
	anchor: [number, number];
	berths: Record<YouSlot, Vec3>;
	layout: YouSpotLayout;
} {
	if (column) {
		return stripLayout(width);
	}
	const narrow = width < STATION_NARROW;
	const berths = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => {
			if (narrow) {
				const column = index % 2;
				const row = Math.floor(index / 2);
				// The first two ask berths are the top row, nearest the sky.
				return [slot, [(column - 0.5) * BERTH_GAP, (1 - row) * 2, 0]];
			}
			return [slot, [(index - 1.5) * BERTH_GAP, 0, 0]];
		})
	) as Record<YouSlot, Vec3>;
	const tray: Vec3 = narrow ? [4.8, 0.45, 0] : [1.5 * BERTH_GAP, 2.6, 0];
	const tally: Vec3 = narrow
		? [-0.5 * BERTH_GAP, 3.6, 0]
		: [-1.5 * BERTH_GAP, 2.4, 0];
	return {
		// Bottom-right, clear of the legend and, on a phone, of the folded sheet.
		anchor: narrow ? [248, 120] : [280, 60],
		berths,
		layout: {
			offStage: [tally[0], tally[1] + 1.2, 0],
			slots: berths,
			tally,
			timer: [0.95, 0.1, 0],
			tray,
		},
	};
}

/** Half a queue plate's width beside a phone's strip, px. */
const STRIP_HALF_PX = 50;

/**
 * The screen box (px in the scene) a phone's station strip takes, from its
 * tallies to its cargo bay, so the name plates can keep clear of it; null
 * when the station is not a strip.
 */
export function stationStripBox(
	size: { height: number; width: number },
	column: boolean
): { bottom: number; left: number; right: number; top: number } | null {
	if (!column) {
		return null;
	}
	const { anchor, layout } = stripLayout(size.width);
	const x = size.width - anchor[0];
	const y = size.height - anchor[1];
	return {
		bottom: y - (layout.tray[1] - 0.6) * STATION_UNIT_PX,
		left: 0,
		right: x + STRIP_HALF_PX,
		top: y - (layout.offStage[1] + 0.4) * STATION_UNIT_PX,
	};
}

/**
 * A phone's station: a strip down the scene's left edge, in the room the
 * column of planets leaves beside it. The tallies stand above the top
 * berth, the cargo bay below the last; the origin is the top berth.
 */
function stripLayout(width: number): {
	anchor: [number, number];
	berths: Record<YouSlot, Vec3>;
	layout: YouSpotLayout;
} {
	const berths = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => [slot, [0, -index * STRIP_GAP, 0]])
	) as Record<YouSlot, Vec3>;
	const tally: Vec3 = [0, 1.9, 0];
	return {
		anchor: [Math.max(0, width - STRIP_INSET), STRIP_TOP],
		berths,
		layout: {
			offStage: [0, tally[1] + 1.2, 0],
			slots: berths,
			tally,
			timer: [0.95, 0.1, 0],
			// The capsule draws a little left of the bay's own point.
			tray: [0.6, -YOU_SLOTS.length * STRIP_GAP + 0.6, 0],
			trayMax: 2,
		},
	};
}

/** The screen's right, up and toward-the-camera axes in the world. */
export function screenAxes(
	azimuth: number,
	elevation: number
): { front: Vec3; right: Vec3; up: Vec3 } {
	const front: Vec3 = [Math.sin(azimuth), 0, Math.cos(azimuth)];
	return {
		front,
		right: [Math.cos(azimuth), 0, -Math.sin(azimuth)],
		up: [
			-Math.sin(elevation) * front[0],
			Math.cos(elevation),
			-Math.sin(elevation) * front[2],
		],
	};
}

/** The overview camera's tilt: steeper for a phone's column. */
const OVERVIEW_TILT = 0.68;

/** `right · r + up · u + front · f` for the overview camera. */
function screenPoint(
	azimuth: number,
	column: boolean,
	right: number,
	up: number,
	front = 0
): Vec3 {
	const axes = screenAxes(azimuth, column ? COLUMN_ELEVATION : OVERVIEW_TILT);
	const along = (axis: 0 | 1 | 2) =>
		axes.right[axis] * right + axes.up[axis] * up + axes.front[axis] * front;
	return [along(0), along(1), along(2)];
}

/**
 * Where a planet's station pieces sit, in planet radii from its centre as
 * the overview camera sees it: alarms to its right, the board of status
 * words above it (its name plate hangs below), unread and suggestion
 * openers to its left; the kit's pips and cue sit inside the world (its
 * progress is the arc round the focus moon).
 */
export function planetStationLayout(
	azimuth: number,
	column: boolean
): Partial<StationLayout> {
	const at = (right: number, up: number) =>
		screenPoint(azimuth, column, right, up);
	return {
		alarmSide: "right",
		alarms: at(1.45, 0.2),
		board: at(0, 1.75),
		cue: [0, 0, 0],
		limit: at(-1.4, 0.3),
		next: at(-1.3, -0.5),
		pips: [0, 0, 0],
		suggestion: at(-1.5, 0.7),
		unread: at(-1.5, -0.3),
	};
}

/**
 * Where a planet's probe goes for its act (`actorTarget`): its berth while
 * it asks, the cargo bay while its answer waits, else home. Station places
 * are the station's own; "home" is the planet.
 */
export function probePlace(
	act: InterfaceAgentAct,
	slots: readonly YouSpotSlot[],
	still: boolean
): "home" | YouSlot | "tray" | "you" {
	// Each place is a numbered point, so the kit's choice reads back as a name.
	const names: ("home" | YouSlot | "tray" | "you")[] = [
		"home",
		"you",
		"tray",
		...YOU_SLOTS,
	];
	const kitNames = new Map<string, string>([
		["tray", YOU_TRAY],
		["you", YOU_SPOT],
	]);
	const points: Record<string, Vec3> = {};
	for (const [index, name] of names.entries()) {
		points[kitNames.get(name) ?? name] = [index, 0, 0];
	}
	const target = actorTarget(
		act,
		{
			paths: { links: [], points },
			slot: slotOf(slots, act.agentId),
			station: "home",
		},
		still
	).position[0];
	return names[target] ?? "home";
}

/** What the act layer needs from the DOM side. */
export interface PlanetsActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	/** The scene's CSS width (the station's narrow layout). */
	width: number;
}

const tint = (color: string, opacity = 1) => (
	<meshBasicMaterial
		color={color}
		opacity={opacity}
		toneMapped={false}
		transparent={opacity < 1}
	/>
);

/**
 * Holds the station's group in front of the camera at its anchor: each
 * frame after the camera moves (priority -1, mounted after the camera
 * rig), at a fixed depth and a fixed pixel scale.
 */
function StationRig({
	anchor,
	rig,
}: {
	anchor: [number, number];
	rig: RefObject<Group | null>;
}) {
	useFrame(({ camera, size }) => {
		const group = rig.current;
		if (!group || size.height <= 0) {
			return;
		}
		const x = size.width - anchor[0];
		const y = size.height - anchor[1];
		const ray = camera.position.clone();
		ray
			.set((x / size.width) * 2 - 1, 1 - (y / size.height) * 2, 0.5)
			.unproject(camera)
			.sub(camera.position)
			.normalize();
		const forward = camera.getWorldDirection(camera.position.clone());
		const along = STATION_DEPTH / Math.max(0.2, ray.dot(forward));
		group.position.copy(camera.position).addScaledVector(ray, along);
		group.quaternion.copy(camera.quaternion);
		const perPx =
			(2 * STATION_DEPTH * Math.tan(((FOV / 2) * Math.PI) / 180)) / size.height;
		group.scale.setScalar(perPx * STATION_UNIT_PX);
	}, -1);
	return null;
}

/**
 * The station's hull: a truss through the berths, pads and solar wings (a
 * phone's strip: a spine down the berths, without wings).
 */
function StationHull({ berths }: { berths: Record<YouSlot, Vec3> }) {
	const points = Object.values(berths);
	const xs = points.map((point) => point[0]);
	const ys = [...new Set(points.map((point) => point[1]))];
	const strip = new Set(xs).size === 1;
	const left = Math.min(...xs) - 1.2;
	const right = Math.max(...xs) + 1.2;
	const top = Math.max(...ys) - 0.45;
	const bottom = Math.min(...ys) - 0.45;
	const pads = points.map((point) => (
		<mesh
			key={`pad-${point[0]}:${point[1]}`}
			position={[point[0], point[1] - 0.45, 0]}
		>
			<boxGeometry args={[1.1, 0.24, 0.5]} />
			{tint(PLANETS_ACT.berth)}
		</mesh>
	));
	if (strip) {
		const x = xs[0] ?? 0;
		return (
			<group>
				<mesh position={[x, (top + bottom) / 2, -0.3]}>
					<boxGeometry args={[0.16, top - bottom, 0.16]} />
					{tint(PLANETS_ACT.hullDark)}
				</mesh>
				{pads}
			</group>
		);
	}
	return (
		<group>
			{ys.map((y) => (
				<mesh key={`truss-${y}`} position={[(left + right) / 2, y - 0.45, 0]}>
					<boxGeometry args={[right - left, 0.16, 0.16]} />
					{tint(PLANETS_ACT.hullDark)}
				</mesh>
			))}
			{/* The solar wings at both ends. */}
			{[left - 0.55, right + 0.55].map((x) => (
				<mesh key={`wing-${x}`} position={[x, ys[0] ?? 0, -0.1]}>
					<boxGeometry args={[0.9, 1.6, 0.04]} />
					{tint(PLANETS_ACT.satellitePanel)}
				</mesh>
			))}
			{pads}
			<mesh position={[(left + right) / 2, top, -0.2]}>
				<cylinderGeometry args={[0.55, 0.55, 0.5, 16]} />
				{tint(PLANETS_ACT.hull)}
			</mesh>
		</group>
	);
}

/** A ring light round a berth that drains (clockwise) as the ask waits. */
function RingLight({ at, level }: { at: Vec3; level: number }) {
	const arc = Math.max(0.08, Math.min(1, level)) * Math.PI * 2;
	return (
		<group position={at}>
			<mesh>
				<torusGeometry args={[0.62, 0.035, 6, 40]} />
				{tint(PLANETS_ACT.berth, 0.7)}
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<torusGeometry args={[0.62, 0.07, 6, 40, arc]} />
				{tint(level < 0.25 ? PLANETS_ACT.ringLow : PLANETS_ACT.ringLight)}
			</mesh>
		</group>
	);
}

/** A probe: a small body with two panels, in its ask kind's colour. */
function ProbeShape({ color }: { color: string }) {
	return (
		<group>
			<mesh>
				<boxGeometry args={[0.36, 0.36, 0.36]} />
				{tint(color)}
			</mesh>
			{[-0.42, 0.42].map((x) => (
				<mesh key={x} position={[x, 0, 0]}>
					<boxGeometry args={[0.42, 0.2, 0.03]} />
					{tint(PLANETS_ACT.satellitePanel)}
				</mesh>
			))}
		</group>
	);
}

const LAUNCH_SECONDS = 1.6;
/** A probe leaving its planet spans this share of the planet's width. */
const LAUNCH_SHARE = 0.55;
/** The probe's span in its own units (body and both panels). */
const PROBE_SPAN = 1.26;

/**
 * A probe flying from its planet to its berth (in the world, so it crosses
 * the sky), then docked. It leaves at a size set by its planet's drawn
 * width and grows on screen, steadily, to its berth's size (the station is
 * far nearer the camera than the planets, so the size eases in pixels, not
 * in world units). Reduced motion docks it at once.
 */
function ProbeFlight({
	agentId,
	berth,
	color,
	radius,
	reduced,
	rig,
	sim,
}: {
	agentId: string;
	berth: Vec3;
	color: string;
	/** The planet's radius (before the overview swell). */
	radius: number;
	reduced: boolean;
	rig: RefObject<Group | null>;
	sim: RefObject<ActSim>;
}) {
	const probe = useRef<Group>(null);
	const start = useRef<number | null>(null);
	useFrame(({ camera, clock, size }) => {
		const group = probe.current;
		const station = rig.current;
		const home = sim.current.positions.get(agentId);
		if (!(group && station) || size.height <= 0) {
			return;
		}
		start.current ??= clock.elapsedTime;
		const t = reduced
			? 1
			: Math.min(1, (clock.elapsedTime - start.current) / LAUNCH_SECONDS);
		const eased = 1 - (1 - t) ** 3;
		const docked = group.position.clone().set(...berth);
		station.localToWorld(docked);
		const from = home ?? [docked.x, docked.y, docked.z];
		group.position.set(
			from[0] + (docked.x - from[0]) * eased,
			from[1] + (docked.y - from[1]) * eased,
			from[2] + (docked.z - from[2]) * eased
		);
		group.quaternion.copy(station.quaternion);
		// World units per pixel at a point's depth in front of the camera.
		const forward = camera.getWorldDirection(docked.clone());
		const halfTan = Math.tan(((FOV / 2) * Math.PI) / 180);
		const perPx = (x: number, y: number, z: number) =>
			(2 *
				Math.max(
					0.1,
					(x - camera.position.x) * forward.x +
						(y - camera.position.y) * forward.y +
						(z - camera.position.z) * forward.z
				) *
				halfTan) /
			size.height;
		const startUnitPx =
			(2 * radius * sim.current.bodyScale * LAUNCH_SHARE) /
			PROBE_SPAN /
			perPx(from[0], from[1], from[2]);
		const unitPx = startUnitPx + (STATION_UNIT_PX - startUnitPx) * eased;
		const at = group.position;
		group.scale.setScalar(unitPx * perPx(at.x, at.y, at.z));
		group.visible = home !== undefined || t >= 1;
	}, -1);
	return (
		<group ref={probe}>
			<ProbeShape color={color} />
		</group>
	);
}

const BLINK_SECONDS = 0.9;

/** The cargo capsule of a ready answer: it blinks while unread. */
function CargoCapsule({ at, reduced }: { at: Vec3; reduced: boolean }) {
	const light = useRef<Group>(null);
	useFrame(({ clock }) => {
		if (light.current) {
			light.current.visible =
				reduced || Math.floor(clock.elapsedTime / BLINK_SECONDS) % 2 === 0;
		}
	});
	return (
		<group position={[at[0] - 1.05, at[1] + 0.3, at[2]]}>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<capsuleGeometry args={[0.24, 0.5, 4, 10]} />
				{tint(PLANETS_ACT.capsule)}
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<torusGeometry args={[0.25, 0.05, 6, 16]} />
				{tint(PLANETS_ACT.capsuleBand)}
			</mesh>
			<group ref={light}>
				<mesh position={[0, 0.38, 0]}>
					<sphereGeometry args={[0.09, 10, 8]} />
					{tint(PLANETS_ACT.ringLight)}
				</mesh>
			</group>
		</group>
	);
}

/**
 * Follows a planet each frame: its centre, scaled to its drawn radius, so
 * the pieces inside are placed in planet radii.
 */
function PlanetFollow({
	children,
	planet,
	sim,
}: {
	children: ReactNode;
	planet: Planet;
	sim: RefObject<ActSim>;
}) {
	const group = useRef<Group>(null);
	useFrame(() => {
		const node = group.current;
		const at = sim.current.positions.get(planet.id);
		if (!(node && at)) {
			return;
		}
		node.position.set(...at);
		node.scale.setScalar(planet.radius * sim.current.bodyScale);
	}, -1);
	return <group ref={group}>{children}</group>;
}

/** A satellite on an orbit marker round a working world (still when reduced). */
function WorkingSatellite({
	reduced,
	tilt,
}: {
	reduced: boolean;
	tilt: number;
}) {
	const spin = useRef<Group>(null);
	useFrame((_, delta) => {
		if (spin.current && !reduced) {
			spin.current.rotation.y += Math.min(delta, 0.1) * 0.8;
		}
	});
	return (
		<group rotation={[tilt, 0, 0.2]}>
			<mesh rotation={[Math.PI / 2, 0, 0]}>
				<torusGeometry args={[1.55, 0.025, 4, 64]} />
				{tint(PLANETS_ACT.satellite, 0.55)}
			</mesh>
			<group ref={spin} rotation={[0, 0.9, 0]}>
				<group position={[1.55, 0, 0]} scale={0.32}>
					<ProbeShape color={PLANETS_ACT.satellite} />
				</group>
			</group>
		</group>
	);
}

/** The signs at a planet for its act: storm band, dark moon, eclipse, satellite. */
function PlanetSigns({
	act,
	azimuth,
	column,
	reduced,
}: {
	act: InterfaceAgentAct;
	azimuth: number;
	column: boolean;
	reduced: boolean;
}) {
	const failed = act.blockers.some((blocker) => isRedBlocker(blocker));
	const interrupted =
		!failed && act.blockers.some((blocker) => blocker.kind === "interrupted");
	return (
		<group>
			{failed ? (
				<mesh rotation={[Math.PI / 2 - 0.25, 0, 0]}>
					<torusGeometry args={[1.04, 0.11, 8, 48]} />
					{tint(PLANETS_ACT.storm, 0.9)}
				</mesh>
			) : null}
			{interrupted ? (
				<mesh position={screenPoint(azimuth, column, 1.25, 0.85, 0.4)}>
					<sphereGeometry args={[0.3, 16, 12]} />
					{tint(PLANETS_ACT.darkMoon)}
				</mesh>
			) : null}
			{act.act === "limited" ? (
				// The eclipse: a shadow drawn over the near face of the world.
				<mesh position={screenPoint(azimuth, column, 0.45, 0.1, 0.6)}>
					<sphereGeometry args={[0.92, 24, 16]} />
					{tint(PLANETS_ACT.eclipse, 0.62)}
				</mesh>
			) : null}
			{act.act === "working" && !act.stalled ? (
				<WorkingSatellite reduced={reduced} tilt={column ? 0.4 : 0.15} />
			) : null}
		</group>
	);
}

/** A progress pip's radius on screen, px. */
const PIP_PX = 4.5;
/** Clear space between pips along the arc, px. */
const PIP_SPACING_PX = 4;
/** Clear space between the moon's rim and the arc, px. */
const ARC_GAP_PX = 7;
/** The arc's sweep over the top of the moon (radians). */
const ARC_SWEEP = Math.PI * 0.8;

/** World units per screen pixel at `depth` in front of the camera. */
function worldPerPx(depth: number, height: number): number {
	return (
		(2 * Math.max(0.1, depth) * Math.tan(((FOV / 2) * Math.PI) / 180)) /
		Math.max(1, height)
	);
}

/** The progress arc's pips for `act` (0 when it draws none). */
function arcPipCount(act: InterfaceAgentAct, planet: Planet): number {
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
function ProgressArc({
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
const BOARD_LIFT = 1.75;
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
const BOARD_STEP = 0.25;
/** How far ahead along its orbit the focus moon is watched (seconds). */
const ARC_HORIZON = 6;
const ARC_SAMPLES = 8;
/** A planet's alarms stand this far to its right (planet radii; see the layout). */
const ALARM_RIGHT = 1.45;
/** Half an icon-only alarm's width, px. */
const ALARM_HALF_PX = 18;
/** Clear space between a phone's board and the scene's right edge, px. */
const SCENE_EDGE_PX = 8;

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

/**
 * A planet's kit station, its board placed (in steps) clear of the world
 * and of its progress arc as the camera's zoom changes their size on
 * screen: lifted over the planet in the overview, beside it in a phone's
 * column.
 */
function PlanetStation({
	act,
	azimuth,
	column,
	layout,
	planet,
	reduced,
	sim,
	view,
}: {
	act: InterfaceAgentAct;
	azimuth: number;
	column: boolean;
	layout: Partial<StationLayout>;
	planet: Planet;
	reduced: boolean;
	sim: RefObject<ActSim>;
	view: PlanetsActView;
}) {
	const lines = stationLines(act, view.shown, {
		clock: view.clock,
		limitText: planetsLimitText,
		nowMs: view.nowMs,
	});
	const size = boardSize(lines);
	const arcPips = arcPipCount(act, planet);
	const alarms = act.blockers.length > 0;
	const moon =
		planet.moons.find((item) => item.threadId === act.threadId) ?? null;
	const [place, setPlace] = useState({ right: 0, up: BOARD_LIFT });
	const scratch = useRef<Vector3 | null>(null);
	useFrame(({ camera, size: screen }) => {
		const at = sim.current.positions.get(planet.id);
		if (!at || size.height === 0 || screen.height <= 0) {
			return;
		}
		const scale = sim.current.bodyScale;
		const depth = Math.hypot(
			at[0] - camera.position.x,
			at[1] - camera.position.y,
			at[2] - camera.position.z
		);
		const perPx = worldPerPx(depth, screen.height);
		const planetPx = (planet.radius * scale) / perPx;
		// The screen's right and up axes in the world (the camera's columns).
		const axes = camera.matrixWorld.elements;
		const right: Vec3 = [axes[0] ?? 1, axes[1] ?? 0, axes[2] ?? 0];
		const up: Vec3 = [axes[4] ?? 0, axes[5] ?? 1, axes[6] ?? 0];
		const body = moon
			? sim.current.moonGroups.get(moonKey(planet.id, moon.threadId))
			: undefined;
		const arcs =
			moon && body && arcPips > 0
				? arcSpans({
						horizon: reduced ? 0 : ARC_HORIZON,
						moon,
						offset: [body.position.x, body.position.y, body.position.z],
						perPx,
						pips: arcPips,
						right,
						scale,
						up,
					})
				: [];
		// A phone's column keeps the usual lift where the board clears its
		// world there (the next world up stands just above), else the board
		// goes beside.
		const tall = BOARD_LIFT * planetPx - size.height / 2 < planetPx;
		if (column && !tall) {
			if (place.right !== 0 || place.up !== BOARD_LIFT) {
				setPlace({ right: 0, up: BOARD_LIFT });
			}
			return;
		}
		if (column) {
			scratch.current ??= camera.position.clone();
			const centre = scratch.current.set(...at).project(camera);
			const room = screen.width * (1 - (centre.x * 0.5 + 0.5)) - SCENE_EDGE_PX;
			const beside = boardBeside({ alarms, arcs, planetPx, room, size });
			if (beside !== place.right || place.up !== 0) {
				setPlace({ right: beside, up: 0 });
			}
			return;
		}
		const needed = boardLift({ arcs, planetPx, size });
		// Rise at once; settle back only past a step (no flicker at an edge).
		if (
			place.right !== 0 ||
			needed > place.up ||
			needed < place.up - BOARD_STEP
		) {
			setPlace({ right: 0, up: needed });
		}
	});
	const placed = useMemo(
		() => ({
			...layout,
			board: screenPoint(azimuth, column, place.right, place.up),
		}),
		[azimuth, column, layout, place]
	);
	return (
		<ActStation
			act={act}
			at={[0, 0, 0]}
			clock={view.clock}
			focusable={false}
			iconOnly={view.iconOnly}
			layout={placed}
			limitText={planetsLimitText}
			nowMs={view.nowMs}
			onAsk={view.onAsk}
			onBlocker={view.onBlocker}
			pipSkin={{
				done: PLANETS_ACT.pipDone,
				todo: PLANETS_ACT.pipTodo,
			}}
			privacy={view.privacy}
			reduced={reduced}
			shown={view.shown}
			snapshot={view.snapshot}
		/>
	);
}

/**
 * The whole act layer: the station in the foreground (berths, probes,
 * capsule, tallies) and every planet's signs and station.
 */
export function PlanetsActLayer({
	azimuth,
	reduced,
	sim,
	system,
	view,
}: {
	azimuth: number;
	reduced: boolean;
	sim: RefObject<ActSim>;
	system: PlanetSystem;
	view: PlanetsActView;
}) {
	const rig = useRef<Group>(null);
	const column = system.column === true;
	const station = stationLayout(view.width, column);
	const layout = useMemo(
		() => planetStationLayout(azimuth, column),
		[azimuth, column]
	);
	const slots = view.slots.slots;
	const asking = slots.filter((slot) => slot.carrier === "villager");
	return (
		<group>
			<StationRig anchor={station.anchor} rig={rig} />
			{asking.map((slot) => {
				const act = slot.agentId ? view.acts.get(slot.agentId) : undefined;
				const place = act ? probePlace(act, slots, reduced) : "home";
				if (!act || place === "home" || place === "tray" || place === "you") {
					return null;
				}
				return (
					<ProbeFlight
						agentId={act.agentId}
						berth={station.berths[place]}
						color={PLANETS_ACT.probe[slot.ask.kind]}
						key={slot.ask.id}
						radius={
							system.planets.find((planet) => planet.id === act.agentId)
								?.radius ?? 1
						}
						reduced={reduced}
						rig={rig}
						sim={sim}
					/>
				);
			})}
			<group ref={rig}>
				<StationHull berths={station.berths} />
				{asking.map((slot) => {
					const act = slot.agentId ? view.acts.get(slot.agentId) : undefined;
					if (!act) {
						return null;
					}
					const berth = station.berths[slot.point];
					const Icon = PROBE_ICONS[slot.ask.kind];
					const timer = {
						approx: slot.ask.sinceApprox,
						since: slot.ask.since,
						until: slot.ask.expiresAt ?? null,
						untilApprox: slot.ask.expiresApprox,
					};
					return (
						<group key={slot.ask.id}>
							<RingLight at={berth} level={timerLevel(timer, view.nowMs)} />
							<IsoMarker
								actAgent={act.agentId}
								activate={() => view.onAsk(slot.ask.id)}
								at={[berth[0], berth[1] + PLATE_LIFT, berth[2]]}
								focusable={false}
								label={`${act.ariaLabel} Answer their ask.`}
								youSpot="slot"
							>
								<Icon aria-hidden="true" className="size-3.5" />
								{queuePlateText(act.agentName, timer, view.nowMs)}
							</IsoMarker>
						</group>
					);
				})}
				{view.onStage
					.filter((act) => act.act === "delivering" && act.ask)
					.slice(0, 1)
					.map((act) => (
						<CargoCapsule
							at={station.layout.tray}
							key={act.agentId}
							reduced={reduced}
						/>
					))}
				<YouSpots
					focusable={false}
					iconOnly={view.iconOnly}
					item={PLANETS_SKIN.deliverable}
					layout={station.layout}
					nowMs={view.nowMs}
					offStage={view.offStage}
					onAsk={view.onAsk}
					onOpenQueue={view.onQueue}
					onStage={view.onStage}
					owners={view.owners}
					privacy={view.privacy}
					reduced={reduced}
					shown={view.shown}
					slots={view.slots}
					snapshot={view.snapshot}
					timerSkin={{ color: PLANETS_ACT.hullDark }}
				/>
			</group>
			{system.planets.map((planet) => {
				const act = view.acts.get(planet.id);
				if (!act) {
					return null;
				}
				return (
					<group key={planet.id}>
						<PlanetFollow planet={planet} sim={sim}>
							<PlanetSigns
								act={act}
								azimuth={azimuth}
								column={column}
								reduced={reduced}
							/>
							<PlanetStation
								act={act}
								azimuth={azimuth}
								column={column}
								layout={layout}
								planet={planet}
								reduced={reduced}
								sim={sim}
								view={view}
							/>
						</PlanetFollow>
						<ProgressArc
							act={act}
							azimuth={azimuth}
							column={column}
							planet={planet}
							sim={sim}
						/>
					</group>
				);
			})}
		</group>
	);
}
