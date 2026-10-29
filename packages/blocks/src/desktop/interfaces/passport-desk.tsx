/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useMemo, useRef } from "react";
import type { Group } from "three";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import {
	fitIso,
	ISO_ANGLE,
	type IsoAngle,
	type IsoBounds,
	type IsoInsets,
	type IsoPortrait,
} from "./game3d-stage.tsx";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	type Passport,
	type PassportCountry,
	type PassportPage,
	type PassportSpread,
	type PassportStamp,
	plural,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
} from "./passport-model.ts";
import { FACE_WIDTH, PHOTO_FEET } from "./passport-page-face.tsx";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./passport-pages.tsx";
import { type DeskArt, tabInk } from "./passport-palette.ts";

/**
 * Passport as a desk diorama on the game kit (game3d-stage.tsx): the
 * passport booklet lies open on a desk, on a leather blotter, and turning
 * its pages is how you move through it. A wide stage shows a two-page
 * spread, a phone one page. The identity page sums the passport up; every
 * agent has a visa page, with its villager standing in the photo frame,
 * its name, its emblem and its status, and its conversations as stamps.
 *
 * Every visa page also has an index tab that pokes out round the booklet's
 * edge, and the agent's villager stands on its tab whichever page is open:
 * that figure is the agent's control (it files a visa application, or with
 * the act layer acts out the agent's state; passport-acts.tsx). The page
 * faces are DOM (passport-page-face.tsx) laid flat on the toon paper.
 */

export type DeskMode = "single" | "spread";

/** A page's width and depth on the desk (world units). */
export const PAGE_W = 6;
export const PAGE_D = (PAGE_W * PAGE_HEIGHT) / PAGE_WIDTH;
/** World units per face px. */
export const FACE_SCALE = PAGE_W / FACE_WIDTH;
/** The cover board's lip round the pages. */
const LIP = 0.22;
const BOARD_H = 0.06;
const BLOCK_H = 0.14;
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

/**
 * A country's villager pose from its stamps: refused, busy, your turn. A
 * denied (failed) run outranks a processing one, so a failure stays in
 * sight while another run of the same agent works.
 */
export function countryPose(stamps: readonly PassportStamp[]): VillagerPose {
	if (stamps.some((stamp) => stamp.marking === "denied")) {
		return "failed";
	}
	if (stamps.some((stamp) => stamp.marking === "processing")) {
		return "working";
	}
	if (stamps.some((stamp) => stamp.marking === "arrived")) {
		return "needs-you";
	}
	if (stamps.some((stamp) => stamp.marking === "applied")) {
		return "waiting";
	}
	return "idle";
}

/** What a country's row says to a screen reader (the list without WebGL). */
export function stationLabel(station: {
	country: PassportCountry | null;
	stamps: readonly PassportStamp[];
}): string {
	const name = station.country?.agent.name ?? UNASSIGNED_LABEL;
	return `${name} (${station.country?.code ?? UNASSIGNED_CODE}): ${plural(station.stamps.length, "stamp", "stamps")}. Open its visa pages`;
}

/**
 * A country row's name with the act layer: the country, not its agent (the
 * agent's own row button is its one target, named by its act).
 */
export function countryLabel(station: {
	country: PassportCountry | null;
	stamps: readonly PassportStamp[];
}): string {
	return `Country ${station.country?.code ?? UNASSIGNED_CODE}: ${plural(station.stamps.length, "stamp", "stamps")}. Open its visa pages`;
}

/** Where a shown page lies: its middle across the desk. */
export function pageMiddle(mode: DeskMode, side: "left" | "right"): number {
	if (mode === "single") {
		return 0;
	}
	return side === "left" ? -PAGE_W / 2 : PAGE_W / 2;
}

/** Where an agent's photo villager stands on its visa page. */
export function photoSpot(mode: DeskMode, side: "left" | "right"): Vec3 {
	const left = pageMiddle(mode, side) - PAGE_W / 2;
	return deskPoint(
		left + PHOTO_FEET.x * FACE_SCALE,
		-PAGE_D / 2 + PHOTO_FEET.y * FACE_SCALE,
		PAGE_TOP
	);
}

/** The agents whose visa page (its first page) shows in `spread`. */
export function shownPhotos(
	pages: readonly PassportPage[],
	spread: PassportSpread | undefined
): { countryId: string; side: "left" | "right" }[] {
	const sides: ["left" | "right", number | null | undefined][] = [
		["left", spread?.left],
		["right", spread?.right],
	];
	const shown: { countryId: string; side: "left" | "right" }[] = [];
	for (const [side, index] of sides) {
		const page = index === null || index === undefined ? null : pages[index];
		if (page?.kind === "visa" && page.first && page.countryId) {
			shown.push({ countryId: page.countryId, side });
		}
	}
	return shown;
}

/** Plank seams across the desk, a board's width apart. */
const SEAMS = Array.from({ length: 21 }, (_, index) => (index - 10) * 3.2);

/** The desk, the blotter, and the booklet's boards and page blocks. */
function DeskAndBooklet({
	art,
	closed,
	layout,
}: {
	art: DeskArt;
	closed: boolean;
	layout: DeskLayout;
}) {
	const extent = deskExtent(layout);
	const blotter = {
		depth: extent.maxB - extent.minB - 1.2,
		middle: (extent.maxB + extent.minB) / 2 - 0.3,
		width: layout.ring.a * 2 + 1.8,
	};
	const spread = layout.mode === "spread";
	const pageWidth = spread ? PAGE_W * 2 : PAGE_W;
	// The strip runs from the booklet's back edge to the back row.
	const strip = layout.ring.b - layout.halfB;
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<ToonMesh color={art.desk} position={[0, -0.25, 0]} receiveShadow>
				<boxGeometry args={[120, 0.5, 120]} />
			</ToonMesh>
			{SEAMS.map((z) => (
				<ToonMesh color={art.deskGrain} key={z} position={[0, 0.002, z]}>
					<boxGeometry args={[120, 0.004, 0.06]} />
				</ToonMesh>
			))}
			<ToonMesh
				color={art.blotter}
				ink={PROP_INK}
				position={[0, 0.015, blotter.middle]}
				receiveShadow
			>
				<boxGeometry args={[blotter.width, 0.03, blotter.depth]} />
			</ToonMesh>
			{/* The clip strip between the back row and the booklet. */}
			<ToonMesh
				color={art.strip}
				position={[0, 0.034, -layout.halfB - strip / 2]}
				receiveShadow
			>
				<boxGeometry args={[pageWidth + LIP * 2, 0.008, strip - 0.2]} />
			</ToonMesh>
			{closed ? (
				<ToonMesh
					castShadow
					color={art.cover}
					ink={PROP_INK}
					position={[spread ? PAGE_W / 2 : 0, PAGE_TOP / 2 + 0.03, 0]}
					receiveShadow
				>
					<boxGeometry args={[PAGE_W + LIP * 2, PAGE_TOP, PAGE_D + LIP * 2]} />
				</ToonMesh>
			) : (
				<group position={[0, 0.03, 0]}>
					<ToonMesh
						castShadow
						color={art.cover}
						ink={PROP_INK}
						position={[0, BOARD_H / 2, 0]}
						receiveShadow
					>
						<boxGeometry
							args={[pageWidth + LIP * 2, BOARD_H, PAGE_D + LIP * 2]}
						/>
					</ToonMesh>
					{(spread ? [-PAGE_W / 2, PAGE_W / 2] : [0]).map((x) => (
						<group key={x} position={[x, 0, 0]}>
							<ToonMesh
								castShadow
								color={art.pageEdge}
								ink={PROP_INK * 0.6}
								position={[0, BOARD_H + BLOCK_H / 2 - 0.006, 0]}
								receiveShadow
							>
								<boxGeometry args={[PAGE_W - 0.04, BLOCK_H - 0.012, PAGE_D]} />
							</ToonMesh>
							<ToonMesh
								color={art.paper}
								position={[0, PAGE_TOP - 0.004, 0]}
								receiveShadow
							>
								<boxGeometry args={[PAGE_W - 0.06, 0.008, PAGE_D - 0.04]} />
							</ToonMesh>
						</group>
					))}
					{spread ? (
						<ToonMesh color={art.coverEdge} position={[0, PAGE_TOP, 0]}>
							<boxGeometry args={[0.05, 0.006, PAGE_D]} />
						</ToonMesh>
					) : null}
				</group>
			)}
		</group>
	);
}

/** The index tabs: a paper tab per station, in its country's ink. */
function IndexTabs({ art, layout }: { art: DeskArt; layout: DeskLayout }) {
	return (
		<group position={[0, 0.03, 0]} rotation={[0, FACE_CAMERA, 0]}>
			{layout.stations.map((station) => {
				const across = station.edge === "top";
				return (
					<ToonMesh
						castShadow
						color={
							station.country
								? tabInk(art, station.country.style.ink)
								: art.tabPlain
						}
						ink={PROP_INK * 0.6}
						key={station.id}
						position={[
							station.tab[0],
							BOARD_H + BLOCK_H * 0.55,
							station.tab[1],
						]}
					>
						<boxGeometry
							args={across ? [0.8, 0.03, 0.62] : [0.62, 0.03, 0.8]}
						/>
					</ToonMesh>
				);
			})}
		</group>
	);
}

/** A page face, laid flat on the paper at `middle` across the desk. */
function FaceOnPage({
	children,
	lift = PAGE_TOP,
	middle,
}: {
	children: ReactNode;
	lift?: number;
	middle: number;
}) {
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<group
				position={[middle, lift + 0.035, 0]}
				rotation={[-Math.PI / 2, 0, 0]}
			>
				<Html
					distanceFactor={400 * FACE_SCALE}
					pointerEvents="none"
					transform
					zIndexRange={[2, 0]}
				>
					{children}
				</Html>
			</group>
		</group>
	);
}

/**
 * The leaf that turns between two spreads: it lifts from the right-hand
 * page (forward) or the left (back) and swings over the spine.
 */
function TurningLeaf({
	art,
	direction,
	onDone,
}: {
	art: DeskArt;
	direction: 1 | -1;
	onDone: () => void;
}) {
	const hinge = useRef<Group>(null);
	const elapsed = useRef(0);
	const done = useRef(false);
	useFrame((_, delta) => {
		const node = hinge.current;
		if (!node || done.current) {
			return;
		}
		elapsed.current += delta;
		const t = Math.min(1, elapsed.current / LEAF_SECONDS);
		const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
		node.rotation.z = direction === 1 ? eased * Math.PI : (1 - eased) * Math.PI;
		if (t >= 1) {
			done.current = true;
			onDone();
		}
	});
	return (
		<group rotation={[0, FACE_CAMERA, 0]}>
			<group
				position={[0, PAGE_TOP + 0.04, 0]}
				ref={hinge}
				rotation={[0, 0, direction === 1 ? 0 : Math.PI]}
			>
				<ToonMesh color={art.paper} position={[PAGE_W / 2, 0.004, 0]}>
					<boxGeometry args={[PAGE_W - 0.06, 0.006, PAGE_D - 0.04]} />
				</ToonMesh>
				<ToonMesh color={art.paperBack} position={[PAGE_W / 2, -0.003, 0]}>
					<boxGeometry args={[PAGE_W - 0.06, 0.006, PAGE_D - 0.04]} />
				</ToonMesh>
			</group>
		</group>
	);
}

/** The act layer's cast and props, when the snapshot carries acts. */
export interface DeskActors {
	/** Exempt plates collapse to glyphs on narrow stages. */
	iconOnly: boolean;
	/** The agents' villagers, driven by their acts (and their helpers). */
	officers: VillagerSpec[];
	paths: LifePaths;
	/** The customs desk and each station's cues. */
	props: ReactNode;
}

export interface DeskSceneProps {
	actors?: DeskActors;
	art: DeskArt;
	/** The customs desk without the act layer (its empty state). */
	customs?: ReactNode;
	/** The face printed on each shown page (null: none). */
	faces: { left: ReactNode; right: ReactNode };
	layout: DeskLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	onApply: (agentId: string) => void;
	/** A leaf turning: forward (1) or back (-1). */
	onTurnDone: () => void;
	pages: readonly PassportPage[];
	reducedMotion: boolean;
	spread: PassportSpread | undefined;
	theme: Scene3dTheme;
	turning: 1 | -1 | null;
}

/** The desk diorama: the open booklet, its tabs, and the agents. */
export function DeskScene({
	actors,
	art,
	customs,
	faces,
	layout,
	looks,
	onApply,
	onTurnDone,
	pages,
	reducedMotion,
	spread,
	turning,
}: DeskSceneProps) {
	const closed = spread?.right === 0 && (spread.left ?? null) === null;
	const photos = useMemo<VillagerSpec[]>(
		() =>
			turning
				? []
				: shownPhotos(pages, spread).flatMap(({ countryId, side }) => {
						const base = looks.get(countryId);
						if (!base) {
							return [];
						}
						return [
							{
								facing: FACE_CAMERA,
								id: `photo:${countryId}`,
								label: "",
								looks: base,
								name: "",
								plate: false as const,
								pose: "idle" as const,
								position: photoSpot(layout.mode, side),
								scale: 0.62,
							},
						];
					}),
		[layout.mode, looks, pages, spread, turning]
	);
	const standing = useMemo<VillagerSpec[]>(
		() =>
			layout.stations.flatMap((station) => {
				const country = station.country;
				const base = country ? looks.get(country.agent.id) : undefined;
				if (!(country && base)) {
					return [];
				}
				return [
					{
						facing: FACE_CAMERA,
						id: country.agent.id,
						label: `${country.agent.name}: apply for a visa`,
						looks: base,
						name: country.agent.name,
						pose: countryPose(station.stamps),
						position: station.at,
					},
				];
			}),
		[layout, looks]
	);
	const villagers = actors?.officers ?? standing;
	const showFaces = turning === null;
	return (
		<group>
			<DeskAndBooklet art={art} closed={closed} layout={layout} />
			<IndexTabs art={art} layout={layout} />
			{showFaces && faces.left !== null && !closed ? (
				<FaceOnPage middle={pageMiddle(layout.mode, "left")}>
					{faces.left}
				</FaceOnPage>
			) : null}
			{showFaces && faces.right !== null ? (
				<FaceOnPage
					lift={closed ? PAGE_TOP + 0.03 : PAGE_TOP}
					middle={
						closed && layout.mode === "spread"
							? PAGE_W / 2
							: pageMiddle(layout.mode, "right")
					}
				>
					{faces.right}
				</FaceOnPage>
			) : null}
			{turning ? (
				<TurningLeaf art={art} direction={turning} onDone={onTurnDone} />
			) : null}
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={photos}
			/>
			{actors ? actors.props : (customs ?? null)}
			<Villagers
				iconOnly={actors?.iconOnly}
				onSelect={onApply}
				paths={actors?.paths}
				reducedMotion={reducedMotion}
				villagers={villagers}
			/>
		</group>
	);
}
