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
import type { Group } from "three";
import type {
	LimitText,
	StationLayout,
	YouSpotLayout,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actorTarget,
	type OffStage,
	slotOf,
	YOU_SLOTS,
	YOU_SPOT,
	YOU_TRAY,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { COLUMN_ELEVATION } from "./planets-model.ts";
import { PLANETS_ACT } from "./planets-palette.ts";

/** The Planets act layer's station layout and placement (see planets-acts.tsx). */

export type Vec3 = [number, number, number];

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
export const STATION_DEPTH = 12;
/** Narrower than this, the berths stand two by two. */
export const STATION_NARROW = 640;
/** How far the queue plates float above their berths (station units). */
export const PLATE_LIFT = 1.1;
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
export function screenPoint(
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
