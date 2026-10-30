import type { Vec3 } from "./game3d-palette.ts";
import {
	fitIso,
	ISO_ANGLE,
	type IsoAngle,
	type IsoBounds,
	type IsoInsets,
	type IsoPortrait,
} from "./game3d-stage.tsx";
import {
	type Passport,
	type PassportCountry,
	type PassportStamp,
	UNASSIGNED_CODE,
} from "./passport-model.ts";
import { FACE_WIDTH } from "./passport-page-face.tsx";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./passport-pages.tsx";

export type DeskMode = "single" | "spread";

/** A page's width and depth on the desk (world units). */
export const PAGE_W = 6;
export const PAGE_D = (PAGE_W * PAGE_HEIGHT) / PAGE_WIDTH;
/** World units per face px. */
export const FACE_SCALE = PAGE_W / FACE_WIDTH;
/** The cover board's lip round the pages. */
export const LIP = 0.22;
export const BOARD_H = 0.06;
export const BLOCK_H = 0.14;
/** The height of the open pages' paper. */
export const PAGE_TOP = BOARD_H + BLOCK_H;
/** A phone looks down on the page from higher up, so it reads. */
export const DESK_PORTRAIT_PITCH = 0.95;
/** A page turns in this long (s). */
export const LEAF_SECONDS = 0.6;

/** Screen right and toward the viewer on the desk (yaw 45). */
const ACROSS: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const TOWARD: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];

/**
 * A desk point from desk coordinates: `a` across the screen (the booklet's
 * width, spine at 0), `b` toward the viewer (its depth, middle at 0).
 */
export function deskPoint(a: number, b: number, y = 0): Vec3 {
	return [ACROSS[0] * a + TOWARD[0] * b, y, ACROSS[2] * a + TOWARD[2] * b];
}

/** Which side of the booklet a tab pokes out of. */
export type DeskEdge = "left" | "right" | "top";

/** One visa page's tab and the spot its villager stands on. */
export interface DeskStation {
	/** Desk coordinates of the villager's spot. */
	ab: [number, number];
	/** Along the ring, clockwise (desk coordinates, unit). */
	along: [number, number];
	/** Where the villager stands. */
	at: Vec3;
	country: PassportCountry | null;
	edge: DeskEdge;
	id: string;
	/** Away from the booklet (desk coordinates, unit). */
	out: [number, number];
	/** The page index of its first visa page. */
	page: number;
	stamps: PassportStamp[];
	/** The tab's middle, in desk coordinates, on the booklet's edge. */
	tab: [number, number];
}

export interface DeskLayout {
	/** The booklet's half width and half depth, boards included. */
	halfA: number;
	halfB: number;
	mode: DeskMode;
	/** The ring the villagers stand on: its half width and back edge. */
	ring: { a: number; b: number };
	stations: DeskStation[];
}

const RING = {
	// The back row stands back from the booklet: its notes ride in the clip
	// strip that opens between the row and the booklet (passport-acts.tsx).
	single: { a: 1.25, b: 2.1 },
	spread: { a: 1.4, b: 2.0 },
} as const;

/** How much of a world unit along the desk's depth shows on screen. */
export function deskSquash(mode: DeskMode): number {
	return Math.sin(mode === "spread" ? ISO_ANGLE.pitch : DESK_PORTRAIT_PITCH);
}

/**
 * The booklet's tabs and their villagers: one station per country (and
 * the unassigned pages, when they have stamps), in page order, spread
 * evenly round the booklet's left, back and right edges by their length on
 * screen. The front edge is left to the customs desk.
 */
export function layoutDesk(passport: Passport, mode: DeskMode): DeskLayout {
	const pages = mode === "spread" ? 2 : 1;
	const halfA = (PAGE_W * pages) / 2 + LIP;
	const halfB = PAGE_D / 2 + LIP;
	const gap = RING[mode];
	const ringA = halfA + gap.a;
	const ringB = halfB + gap.b;
	const sideEnd = halfB - 0.3;
	const squash = deskSquash(mode);
	const places: {
		country: PassportCountry | null;
		id: string;
		stamps: PassportStamp[];
	}[] = passport.countries.map((country) => ({
		country,
		id: country.id,
		stamps: country.stamps,
	}));
	if (passport.unassigned.length > 0) {
		places.push({
			country: null,
			id: UNASSIGNED_CODE,
			stamps: passport.unassigned,
		});
	}
	const side = (sideEnd + ringB) * squash;
	const back = ringA * 2;
	const total = side * 2 + back;
	const stations = places.map((place, index): DeskStation => {
		const along = ((index + 0.5) / places.length) * total;
		let ab: [number, number];
		let edge: DeskEdge;
		if (along < side) {
			edge = "left";
			ab = [-ringA, sideEnd - along / squash];
		} else if (along < side + back) {
			edge = "top";
			ab = [-ringA + (along - side), -ringB];
		} else {
			edge = "right";
			ab = [ringA, -ringB + (along - side - back) / squash];
		}
		const clampA = (value: number) =>
			Math.max(-halfA + 0.5, Math.min(halfA - 0.5, value));
		const clampB = (value: number) =>
			Math.max(-halfB + 0.5, Math.min(halfB - 0.5, value));
		const tab: [number, number] =
			edge === "top"
				? [clampA(ab[0]), -halfB - 0.2]
				: [(edge === "left" ? -1 : 1) * (halfA + 0.2), clampB(ab[1])];
		const out: [number, number] =
			edge === "top" ? [0, -1] : [edge === "left" ? -1 : 1, 0];
		const ringAlong: [number, number] =
			edge === "top" ? [1, 0] : [0, edge === "left" ? -1 : 1];
		return {
			ab,
			along: ringAlong,
			at: deskPoint(ab[0], ab[1]),
			country: place.country,
			edge,
			id: place.id,
			out,
			page: passport.pages.findIndex(
				(page) =>
					page.kind === "visa" &&
					page.first &&
					page.countryId === place.country?.id
			),
			stamps: place.stamps,
			tab,
		};
	});
	return { halfA, halfB, mode, ring: { a: ringA, b: ringB }, stations };
}

/** Room round the ring for each station's props, and for the customs desk. */
const ROOM = {
	single: { back: 1.0, front: 4.2, side: 1.2 },
	spread: { back: 0.8, front: 3.5, side: 2.0 },
} as const;

/** The desk-coordinate box the camera frames: the ring and the customs desk. */
export function deskExtent(layout: DeskLayout) {
	const room = ROOM[layout.mode];
	return {
		maxA: layout.ring.a + room.side,
		maxB: layout.halfB + room.front,
		minA: -layout.ring.a - room.side,
		minB: -layout.ring.b - room.back,
	};
}

function corners(extent: ReturnType<typeof deskExtent>): Vec3[] {
	return [
		deskPoint(extent.minA, extent.minB),
		deskPoint(extent.maxA, extent.minB),
		deskPoint(extent.minA, extent.maxB),
		deskPoint(extent.maxA, extent.maxB),
	];
}

/** The world box round `extent` (it is turned 45 degrees to the world). */
export function deskBounds(layout: DeskLayout, top = 2.8): IsoBounds {
	const points = corners(deskExtent(layout));
	return {
		maxX: Math.max(...points.map((point) => point[0])),
		maxZ: Math.max(...points.map((point) => point[2])),
		minX: Math.min(...points.map((point) => point[0])),
		minZ: Math.min(...points.map((point) => point[2])),
		top,
	};
}

/** The zoom that frames the desk box itself, not its looser world box. */
function exactZoom(
	points: readonly Vec3[],
	top: number,
	width: number,
	height: number,
	insets: IsoInsets,
	angle: IsoAngle
): number {
	const right: Vec3 = [Math.cos(angle.yaw), 0, -Math.sin(angle.yaw)];
	const toward: Vec3 = [
		Math.cos(angle.pitch) * Math.sin(angle.yaw),
		Math.sin(angle.pitch),
		Math.cos(angle.pitch) * Math.cos(angle.yaw),
	];
	const up: Vec3 = [
		toward[1] * right[2] - toward[2] * right[1],
		toward[2] * right[0] - toward[0] * right[2],
		toward[0] * right[1] - toward[1] * right[0],
	];
	let minRight = Number.POSITIVE_INFINITY;
	let maxRight = Number.NEGATIVE_INFINITY;
	let minUp = Number.POSITIVE_INFINITY;
	let maxUp = Number.NEGATIVE_INFINITY;
	for (const [x, , z] of points) {
		for (const y of [0, top]) {
			const across = x * right[0] + z * right[2];
			const rise = x * up[0] + y * up[1] + z * up[2];
			minRight = Math.min(minRight, across);
			maxRight = Math.max(maxRight, across);
			minUp = Math.min(minUp, rise);
			maxUp = Math.max(maxUp, rise);
		}
	}
	const roomWidth = Math.max(80, width - insets.left - insets.right);
	const roomHeight = Math.max(80, height - insets.top - insets.bottom);
	return Math.min(
		roomWidth / Math.max(0.1, maxRight - minRight),
		roomHeight / Math.max(0.1, maxUp - minUp)
	);
}

/**
 * How the stage frames the desk: the world box, and a fill that zooms from
 * that box's fit in to the desk box's own (the world box of a turned box is
 * looser than the box), on wide stages and on phones (steeper there).
 */
export function deskFraming(
	layout: DeskLayout,
	width: number,
	height: number,
	insets: IsoInsets,
	top = 2.8
): { bounds: IsoBounds; fill: number; portrait: IsoPortrait } {
	const bounds = deskBounds(layout, top);
	const points = corners(deskExtent(layout));
	const portraitAngle: IsoAngle = {
		pitch: DESK_PORTRAIT_PITCH,
		yaw: ISO_ANGLE.yaw,
	};
	const fillFor = (angle: IsoAngle) => {
		if (width <= 0 || height <= 0) {
			return 1;
		}
		const loose = fitIso(bounds, width, height, insets, 1, angle).zoom;
		const exact = exactZoom(points, top, width, height, insets, angle);
		return loose > 0 ? exact / loose : 1;
	};
	return {
		bounds,
		fill: fillFor(ISO_ANGLE),
		portrait: {
			bounds,
			fill: fillFor(portraitAngle),
			pitch: DESK_PORTRAIT_PITCH,
		},
	};
}
