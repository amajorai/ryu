import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { DOOR_RECT } from "./world-2d-buildings.ts";
import {
	bayer,
	paintFlower,
	paintLilyPad,
	paintMushroom,
	paintPebble,
	paintTallGrass,
	paintTuft,
	paintTwig,
} from "./world-2d-flora.ts";
import {
	inClearing,
	insidePond,
	insideWorld,
	isOuterRoad,
	type SceneFrame,
	type TileRect,
	type VillageProps,
} from "./world-2d-layout.ts";
import type { PixelScene } from "./world-2d-palette.ts";
import { SWATCH } from "./world-2d-palette.ts";
import {
	light,
	mix,
	noise,
	PixelBuffer,
	PX,
	parseHex,
	shade,
} from "./world-2d-pixel.ts";
import { tileHash, tileKey, type VillageLayout } from "./world-village.ts";

/**
 * The static ground of the 2D village, baked once per layout and theme into
 * one low-resolution canvas: dithered grass with tufts and wildflowers, dirt
 * streets whose edges are autotiled against the grass around them, a
 * cobblestone plaza of individually outlined stones, and the soft shadows of
 * everything standing on it. Indoors: oak planks, rugs in three colorways
 * (a runner under each row of desks and a smaller one in the lobby)
 * and the wallpapered back wall.
 */

type Material =
	| "cobble"
	| "dirt"
	| "floor"
	| "front"
	| "grass"
	| "rug"
	| "trim"
	| "void"
	| "wall"
	| "water";

export interface GroundShadow {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

interface GroundInput {
	frame: SceneFrame;
	layout: WorldLayout;
	props: VillageProps;
	/** Rug rectangles (indoor), filled in by `buildGround`. */
	rugs?: Rug[];
	scene: PixelScene;
	shadows: readonly GroundShadow[];
	village: VillageLayout;
}

/** A rug: its tiles and which colorway it is woven in. */
interface Rug extends TileRect {
	tone: number;
}

/**
 * The rugs (indoor), in world tiles: a runner under each row of desks, the
 * rows taking turns between colorways, and a smaller rug in the lobby in
 * front of the entrance.
 */
function rugRects(input: GroundInput): Rug[] {
	const rows = new Map<number, number[]>();
	for (const entity of input.layout.entities) {
		const xs = rows.get(entity.y) ?? [];
		xs.push(entity.x);
		rows.set(entity.y, xs);
	}
	const rects: Rug[] = [];
	const ordered = [...rows.entries()].sort(([a], [b]) => a - b);
	ordered.forEach(([y, xs], index) => {
		const x = Math.max(0, Math.min(...xs) - 2);
		const right = Math.min(input.layout.width - 1, Math.max(...xs) + 2);
		rects.push({ h: 3, tone: index % 2, w: right - x + 1, x, y: y - 1 });
	});
	const { layout, village } = input;
	const half = Math.min(3, Math.floor((layout.width - 2) / 2));
	rects.push({
		h: village.plaza.bottom - village.plaza.top + 1,
		tone: 2,
		w: half * 2 + 1,
		x: layout.spawn.x - half,
		y: village.plaza.top,
	});
	return rects;
}

function inRect(rect: TileRect, x: number, y: number): boolean {
	return (
		x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
	);
}

/** Height of the office's back wall, in world tiles. */
const WALL_ROWS = 2;

function materialAt(input: GroundInput, x: number, y: number): Material {
	const { layout, scene, village } = input;
	const inside = insideWorld(layout, x, y);
	// The square: the plaza rows and the row of furniture below them.
	const square = y >= village.plaza.top && y <= village.plaza.bottom + 1;
	if (scene.indoor) {
		if (!inside) {
			if (y >= layout.height && x >= -1 && x <= layout.width) {
				return "front";
			}
			const besideRoom =
				(x === -1 || x === layout.width) &&
				y >= -WALL_ROWS &&
				y < layout.height;
			if (besideRoom) {
				return "trim";
			}
			return y < 0 && y >= -WALL_ROWS && x >= 0 && x < layout.width
				? "wall"
				: "void";
		}
		return (input.rugs ?? []).some((rect) => inRect(rect, x, y))
			? "rug"
			: "floor";
	}
	if (inside && square) {
		return "cobble";
	}
	if (insidePond(input.props.pond, x, y)) {
		return "water";
	}
	if (isOuterRoad(layout, village, x, y) || village.paths.has(tileKey(x, y))) {
		return "dirt";
	}
	// The gap in the square's fence where the spawn column comes through.
	if (
		x === layout.spawn.x &&
		y === village.plaza.top - 1 &&
		village.paths.has(tileKey(x, y - 1))
	) {
		return "dirt";
	}
	return "grass";
}

/** Paved materials share edges; grass and floor are the open ground. */
function paved(material: Material): boolean {
	return material === "cobble" || material === "dirt" || material === "rug";
}

/**
 * Distance in pixels from (lx, ly) inside a paved tile to the nearest
 * unpaved neighbor, with rounded outer corners and filleted inner corners:
 * the autotile edge, computed per pixel.
 */
function edgeDistance(
	open: (dx: number, dy: number) => boolean,
	lx: number,
	ly: number
): number {
	const px = lx + 0.5;
	const py = ly + 0.5;
	const left = !open(-1, 0);
	const right = !open(1, 0);
	const up = !open(0, -1);
	const down = !open(0, 1);
	let d = 99;
	if (left) {
		d = Math.min(d, px);
	}
	if (right) {
		d = Math.min(d, PX - px);
	}
	if (up) {
		d = Math.min(d, py);
	}
	if (down) {
		d = Math.min(d, PX - py);
	}
	const R = 7;
	const corner = (cx: number, cy: number, outer: boolean) => {
		const dist = Math.hypot(px - cx, py - cy);
		if (outer) {
			// Rounded convex corner.
			const ox = cx === 0 ? R : PX - R;
			const oy = cy === 0 ? R : PX - R;
			const inX = cx === 0 ? px < R : px > PX - R;
			const inY = cy === 0 ? py < R : py > PX - R;
			if (inX && inY) {
				d = Math.min(d, R - Math.hypot(px - ox, py - oy));
			}
		} else {
			d = Math.min(d, dist);
		}
	};
	if (up && left) {
		corner(0, 0, true);
	} else if (!(up || left || open(-1, -1))) {
		corner(0, 0, false);
	}
	if (up && right) {
		corner(PX, 0, true);
	} else if (!(up || right || open(1, -1))) {
		corner(PX, 0, false);
	}
	if (down && left) {
		corner(0, PX, true);
	} else if (!(down || left || open(-1, 1))) {
		corner(0, PX, false);
	}
	if (down && right) {
		corner(PX, PX, true);
	} else if (!(down || right || open(1, 1))) {
		corner(PX, PX, false);
	}
	return d;
}

/** Smooth value noise, for broad grass tone patches. */
function valueNoise(x: number, y: number, seed: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);
	const a = noise(x0, y0, seed);
	const b = noise(x0 + 1, y0, seed);
	const c = noise(x0, y0 + 1, seed);
	const d = noise(x0 + 1, y0 + 1, seed);
	return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Grass in four hue-shifted greens: broad patches from value noise whose
 * borders break up in 2x2 clumps (never an ordered checker), with
 * hand-placed-looking blade marks: a dark one or two pixel blade under a
 * lit tip, scattered one per few cells.
 */
function grassColor(scene: PixelScene, gx: number, gy: number): string {
	const v =
		valueNoise(gx / 26, gy / 26, 3) * 0.7 + valueNoise(gx / 9, gy / 9, 8) * 0.3;
	const clump = (noise(gx >> 1, gy >> 1, 5) - 0.5) * 0.5;
	const level = v * 3 + clump;
	const index = Math.max(0, Math.min(2, Math.floor(level)));
	const base = scene.grass[index] ?? scene.grass[0];
	// Blades: one candidate per 4x4 cell, at a hashed spot in the cell.
	const cx = gx >> 2;
	const cy = gy >> 2;
	const n = noise(cx, cy, 13);
	if (n < 0.34) {
		const bx = (cx << 2) + Math.floor(noise(cx, cy, 17) * 3);
		const by = (cy << 2) + Math.floor(noise(cx, cy, 19) * 2);
		const tall = n < 0.12;
		if (gx === bx && gy === by) {
			return index === 2 ? scene.grassTip : light(base, 0.18);
		}
		if (gx === bx && (gy === by + 1 || (tall && gy === by + 2))) {
			return index === 0 ? scene.grassBlade : shade(base, 0.22);
		}
		// A second blade leaning out of the same root.
		if (tall && gx === bx + 1 && gy === by + 2) {
			return shade(base, 0.16);
		}
	}
	return base;
}

/** Hue-shifted highlight (toward warm cream) and shadow (toward violet). */
const STONE_LIGHT = SWATCH.yellow80;
const STONE_SHADE = SWATCH.violet660;

/** A stone in a cobble tile: x, y, width, height in tile pixels. */
type StoneRect = readonly [number, number, number, number];

/**
 * Hand-laid 16x16 cobble tiles: four or five rounded stones each, in
 * staggered courses. Column 15 and row 15 are mortar, so tiles butt
 * together seamlessly; each tile may also be mirrored.
 */
const COBBLE_LAYOUTS: readonly (readonly StoneRect[])[] = [
	[
		[0, 0, 7, 6],
		[8, 0, 7, 6],
		[0, 7, 4, 8],
		[5, 7, 5, 8],
		[11, 7, 4, 8],
	],
	[
		[0, 0, 5, 7],
		[6, 0, 9, 6],
		[0, 8, 8, 7],
		[9, 7, 6, 8],
	],
	[
		[0, 0, 9, 6],
		[10, 0, 5, 9],
		[0, 7, 6, 8],
		[7, 7, 2, 2],
		[7, 10, 8, 5],
	],
	[
		[0, 0, 6, 9],
		[7, 0, 8, 5],
		[7, 6, 4, 9],
		[12, 6, 3, 9],
		[0, 10, 6, 5],
	],
	[
		[0, 0, 5, 5],
		[6, 0, 9, 7],
		[0, 6, 5, 9],
		[6, 8, 5, 7],
		[12, 8, 3, 7],
	],
];

/** Whether (u, v) is cut off a w x h stone's corners (rounder when big). */
function stoneCorner(u: number, v: number, w: number, h: number): boolean {
	if (w < 4 || h < 4) {
		return false;
	}
	const du = Math.min(u, w - 1 - u);
	const dv = Math.min(v, h - 1 - v);
	return w >= 6 && h >= 6 ? du + dv < 2 : du + dv === 0;
}

/** What a cobble pixel is: a stone's face (with its shading) or mortar. */
interface CobblePixel {
	color: string;
	/** Stone center in frame pixels (meaningless for mortar). */
	cx: number;
	cy: number;
	/** 0..1 per stone (for thinning stones out at a path), -1 for mortar. */
	key: number;
}

/**
 * The town cobbles: each 16x16 tile lays out four or five rounded stones
 * in a warm grey-beige. A stone's tone varies per stone, never per pixel:
 * a lit top row (warm cream), a lit left column, a hue-shifted blue-grey
 * shadow along its bottom and right, and a dark warm-brown mortar line
 * all round it.
 */
function cobbleAt(scene: PixelScene, gx: number, gy: number): CobblePixel {
	const { cobble } = scene;
	const tx = gx >> 4;
	const ty = gy >> 4;
	const lx = gx & 15;
	const ly = gy & 15;
	const hash = tileHash(tx + 401, ty + 77);
	const stones = COBBLE_LAYOUTS[hash % COBBLE_LAYOUTS.length] ?? [];
	const mirror = (hash >> 3) % 2 === 1;
	const mortar: CobblePixel = { color: cobble.gap, cx: 0, cy: 0, key: -1 };
	if (lx === 15 || ly === 15) {
		return mortar;
	}
	for (let index = 0; index < stones.length; index++) {
		const stone = stones[index];
		if (!stone) {
			continue;
		}
		const [sx0, sy, w, h] = stone;
		const sx = mirror ? 15 - sx0 - w : sx0;
		if (lx < sx || ly < sy || lx >= sx + w || ly >= sy + h) {
			continue;
		}
		const u = lx - sx;
		const v = ly - sy;
		const rounded = w >= 4 && h >= 4;
		if (stoneCorner(u, v, w, h)) {
			return mortar;
		}
		const key = noise(tx * 8 + index, ty, 71);
		const base = cobble.stones[Math.floor(key * 4)] ?? cobble.stones[0];
		const cx = (tx << 4) + sx + w / 2;
		const cy = (ty << 4) + sy + h / 2;
		let color: string = base;
		if (v === h - 1 || (u === w - 1 && v > 0)) {
			color = mix(base, STONE_SHADE, 0.34);
		} else if (v === 0 || (u === 0 && v < h - 2)) {
			color = mix(base, STONE_LIGHT, 0.42);
		} else if (u === 1 && v === 1 && rounded) {
			color = mix(base, STONE_LIGHT, 0.7);
		} else if (v === h - 2 && u > 1 && rounded) {
			color = mix(base, STONE_SHADE, 0.12);
		}
		return { color, cx, cy, key };
	}
	return mortar;
}

/** Which sides of a tile (dx, dy) border a material, for transitions. */
const SIDES = [
	[0, -1],
	[0, 1],
	[-1, 0],
	[1, 0],
] as const;

/**
 * Distance (in pixels, from a point inside a tile) to the nearest side of
 * the tile that borders `material`, or `Infinity` when none does.
 */
function sideDistance(
	borders: (dx: number, dy: number) => boolean,
	lx: number,
	ly: number
): number {
	let d = Number.POSITIVE_INFINITY;
	for (const [dx, dy] of SIDES) {
		if (!borders(dx, dy)) {
			continue;
		}
		if (dx < 0) {
			d = Math.min(d, lx);
		} else if (dx > 0) {
			d = Math.min(d, PX - lx);
		} else if (dy < 0) {
			d = Math.min(d, ly);
		} else {
			d = Math.min(d, PX - ly);
		}
	}
	return d;
}

/**
 * Where a dirt path meets the square, the paving frays: on the dirt side a
 * few loose cobbles thin out over about a dozen pixels, and on the square
 * side the odd edge stone is missing, so the seam is never a straight cut.
 * `onDirt` says which side this pixel is on; `borders` tests the tile's
 * neighbors for the other material. Returns null for plain ground.
 */
function frayedCobble(
	scene: PixelScene,
	gx: number,
	gy: number,
	tile: { x: number; y: number },
	borders: (dx: number, dy: number) => boolean,
	onDirt: boolean
): string | null {
	const keep = (c: CobblePixel) => {
		if (c.key < 0) {
			return false;
		}
		const d = sideDistance(borders, c.cx - tile.x, c.cy - tile.y);
		if (onDirt) {
			return c.key < Math.max(0, 0.85 - d / 11);
		}
		return c.key >= Math.max(0, 0.5 - d / 9);
	};
	const here = cobbleAt(scene, gx, gy);
	if (keep(here)) {
		return here.color;
	}
	// Mortar (or a gap) next to a stone that stays outlines that stone; on
	// the square's side the mortar between kept stones stays, corners too.
	const reach = onDirt ? 1 : 2;
	for (let dy = -reach; dy <= reach; dy++) {
		for (let dx = -reach; dx <= reach; dx++) {
			if ((onDirt && dx !== 0 && dy !== 0) || (dx === 0 && dy === 0)) {
				continue;
			}
			const next = cobbleAt(scene, gx + dx, gy + dy);
			if (keep(next) && (here.key < 0 || Math.abs(dx) + Math.abs(dy) === 1)) {
				return scene.cobble.gap;
			}
		}
	}
	return null;
}

/**
 * Dirt, by distance from the grass edge: a one-pixel dark lip right under
 * the grass overhang, a broken second shade, then packed dirt with pebbles
 * and soft patches (no ordered dither).
 */
function dirtColor(
	scene: PixelScene,
	gx: number,
	gy: number,
	edge: number
): string {
	const d = scene.dirt;
	if (edge < 1) {
		return d.edge;
	}
	if (edge < 2 && noise(gx >> 1, gy >> 1, 87) < 0.6) {
		return d.dark;
	}
	const n = noise(gx, gy, 81);
	if (n < 0.035) {
		return d.dark;
	}
	if (n < 0.07) {
		return d.light;
	}
	const patch =
		valueNoise(gx / 9, gy / 9, 83) + (noise(gx >> 1, gy >> 1, 85) - 0.5) * 0.2;
	return patch > 0.64 ? d.shade : d.fill;
}

/**
 * How far the grass hangs over a dirt edge here: 1 to 3 pixels, chosen per
 * 2x2 clump so the edge is ragged rather than a dither pattern.
 */
function overhang(gx: number, gy: number): number {
	return 1 + Math.floor(noise(gx >> 1, gy >> 1, 131) * 2.6);
}

/**
 * The town square's cobbles, ringed by a curb of long cut stones (five
 * pixels deep, jointed every nine, lit on top and shaded at the foot) inside
 * a dark outline where it meets the grass.
 */
function squareColor(
	scene: PixelScene,
	open: (dx: number, dy: number) => boolean,
	lx: number,
	ly: number,
	gx: number,
	gy: number,
	edge: number
): string {
	const { cobble } = scene;
	if (edge < 1) {
		return cobble.dark;
	}
	if (edge >= 7) {
		return cobbleAt(scene, gx, gy).color;
	}
	if (edge >= 6) {
		return cobble.gap;
	}
	const sideX = Math.min(
		open(-1, 0) ? 99 : lx + 0.5,
		open(1, 0) ? 99 : PX - lx - 0.5
	);
	const sideY = Math.min(
		open(0, -1) ? 99 : ly + 0.5,
		open(0, 1) ? 99 : PX - ly - 0.5
	);
	const joint = sideX < sideY ? gy % 9 === 0 : gx % 9 === 0;
	if (joint) {
		return cobble.dark;
	}
	const [top, face, foot] = cobble.curb;
	if (edge < 2) {
		return top;
	}
	if (edge >= 5) {
		return foot;
	}
	return noise(gx, gy, 89) < 0.06 ? mix(face, STONE_SHADE, 0.15) : face;
}

/** A rug's colorway: binding, border band, field, lattice, and its gold. */
interface RugTone {
	dark: string;
	edge: string;
	fill: string;
	gold: string;
	light: string;
}

/** The second and third colorways (the first is the theme's red). */
const RUG_TONES: readonly RugTone[] = [
	{
		dark: SWATCH.blue680,
		edge: SWATCH.blue830,
		fill: SWATCH.blue535,
		gold: SWATCH.amber410Dusty,
		light: SWATCH.blue325,
	},
	{
		dark: SWATCH.green730,
		edge: SWATCH.green855,
		fill: SWATCH.green585Muted,
		gold: SWATCH.yellow290,
		light: SWATCH.green380,
	},
];

function rugTone(scene: PixelScene, tone: number): RugTone {
	return (
		RUG_TONES[tone - 1] ?? {
			dark: scene.dirt.dark,
			edge: scene.dirt.edge,
			fill: scene.dirt.fill,
			gold: SWATCH.amber410Dusty,
			light: scene.dirt.light,
		}
	);
}

/**
 * A rectangular rug: a dark binding, a gold line, a border band with a
 * repeating diamond, another gold line, then the field's diamond lattice.
 * `edge` is the distance in pixels to the rug's nearest edge.
 */
function rugColor(tone: RugTone, gx: number, gy: number, edge: number): string {
	const { gold } = tone;
	if (edge < 1) {
		return tone.edge;
	}
	if (edge < 2 || (edge >= 7 && edge < 8)) {
		return gold;
	}
	if (edge < 7) {
		// The border band's diamonds, one every eight pixels along it.
		const along = (gx + gy) % 8;
		const across = edge - 4.5;
		return Math.abs(along - 4) + Math.abs(across) * 1.2 < 2.2
			? gold
			: tone.dark;
	}
	if (edge < 9) {
		return tone.dark;
	}
	const diag = (gx + gy) % 10 === 0 || (gx - gy + 1000) % 10 === 0;
	if (diag) {
		return tone.light;
	}
	return (gx + gy) % 5 === 0 && (gx - gy + 1000) % 10 === 5 ? gold : tone.fill;
}

function floorColor(scene: PixelScene, gx: number, gy: number): string {
	const row = Math.floor(gy / 5);
	const inRow = gy % 5;
	if (inRow === 4) {
		return scene.grassBlade;
	}
	const length = 28 + Math.floor(noise(row, 0, 91) * 3) * 8;
	const offset = Math.floor(noise(row, 1, 93) * length);
	const along = (gx + offset) % length;
	if (along === 0) {
		return scene.grassBlade;
	}
	const plank = Math.floor((gx + offset) / length);
	const tone =
		scene.grass[Math.floor(noise(plank, row, 95) * 3)] ?? scene.grass[0];
	if (inRow === 0) {
		return light(tone, 0.12);
	}
	if (noise(gx, gy, 97) < 0.05) {
		return shade(tone, 0.12);
	}
	return tone;
}

/**
 * The room's wall tops, one tile thick on the left, right and bottom (the
 * back wall is the papered wall above): a dark wood cap with a lit lip on
 * the floor side, grain along its length, and a deep outer edge.
 */
function trimColor(
	layout: { height: number; width: number },
	x: number,
	y: number,
	lx: number,
	ly: number
): string {
	// Distance from the floor side of the wall, per wall this tile is part
	// of; in a corner the larger one wins so the corner closes cleanly.
	const distances: number[] = [];
	const along: number[] = [];
	if (x === -1) {
		distances.push(PX - 1 - lx);
		along.push(ly);
	}
	if (x === layout.width) {
		distances.push(lx);
		along.push(ly);
	}
	if (y === layout.height) {
		distances.push(ly);
		along.push(lx);
	}
	const depth = distances.length > 0 ? Math.max(...distances) : PX;
	if (depth === 0) {
		return SWATCH.amber460Muted;
	}
	if (depth === 1) {
		return SWATCH.orange645;
	}
	if (depth >= PX - 2) {
		return SWATCH.orange900;
	}
	const grain = (along[0] ?? 0) + depth * 5;
	return noise(grain >> 2, depth, 109) < 0.18
		? SWATCH.orange815
		: SWATCH.orange780;
}

/** Baseboard shadow on the floor along every wall (0 = none). */
function wallShadow(
	layout: { height: number; width: number },
	x: number,
	y: number,
	lx: number,
	ly: number
): number {
	let d = PX;
	if (x === 0) {
		d = Math.min(d, lx);
	}
	if (x === layout.width - 1) {
		d = Math.min(d, PX - 1 - lx);
	}
	if (y === 0) {
		d = Math.min(d, ly);
	}
	if (y === layout.height - 1) {
		d = Math.min(d, PX - 1 - ly);
	}
	if (d < 2) {
		return 0.38;
	}
	return d < 3 ? 0.2 : 0;
}

/**
 * The room's front wall below the floor: a wood cap on the wall top (lit
 * lip on the floor side), then wainscot planks with dark seams over a
 * baseboard, a chair rail, and the striped wallpaper below it.
 */
function frontWallColor(gx: number, gy: number, top: number): string {
	const local = gy - top;
	if (local < 4) {
		return (
			[
				SWATCH.amber460Muted,
				SWATCH.orange645,
				SWATCH.orange735,
				SWATCH.orange900,
			][local] ?? SWATCH.orange900
		);
	}
	if (local < 30) {
		const along = gx % 8;
		if (along === 0) {
			return SWATCH.orange780;
		}
		if (along === 1) {
			return SWATCH.orange520;
		}
		if (local === 4) {
			return SWATCH.orange825;
		}
		return noise(gx >> 3, local >> 2, 113) < 0.15
			? SWATCH.orange625
			: SWATCH.orange590;
	}
	if (local < 34) {
		return (
			[
				SWATCH.amber410Ashen,
				SWATCH.orange555,
				SWATCH.orange735,
				SWATCH.orange825,
			][local - 30] ?? SWATCH.orange825
		);
	}
	const stripe = Math.floor(gx / 4) % 2 === 0;
	const dot = gx % 8 === 2 && local % 8 === 4;
	if (dot) {
		return SWATCH.amber430;
	}
	return stripe ? SWATCH.amber285Muted : SWATCH.amber340;
}

function wallColor(gx: number, gy: number, wallTop: number): string {
	const local = gy - wallTop;
	const height = PX * WALL_ROWS;
	if (local >= height - 12) {
		// Wainscot.
		const panel = local - (height - 12);
		if (panel === 0) {
			return SWATCH.amber410Ashen;
		}
		if (panel === 11) {
			return SWATCH.orange825;
		}
		if (gx % 12 === 0) {
			return SWATCH.orange735;
		}
		return panel === 1 ? SWATCH.orange555 : SWATCH.orange645;
	}
	if (local < 2) {
		return local === 0 ? SWATCH.orange735 : SWATCH.orange555;
	}
	const stripe = Math.floor(gx / 4) % 2 === 0;
	const dot = gx % 8 === 2 && local % 8 === 4;
	if (dot) {
		return SWATCH.amber430;
	}
	return stripe ? SWATCH.yellow190Dusty : SWATCH.amber255;
}

function paintWallWindows(buffer: PixelBuffer, input: GroundInput): void {
	const { frame, layout } = input;
	const wallTop = (frame.margin.y - WALL_ROWS) * PX;
	for (let x = 1; x < layout.width - 1; x += 3) {
		const wx = (x + frame.margin.x) * PX + 2;
		const wy = wallTop + 10;
		buffer.rect(wx, wy, 28, 30, SWATCH.yellow70Muted);
		buffer.rect(wx + 2, wy + 2, 24, 26, SWATCH.sky210);
		buffer.rect(wx + 2, wy + 18, 24, 10, SWATCH.sky150);
		buffer.vline(wx + 14, wy + 2, 26, SWATCH.yellow70Muted);
		buffer.hline(wx + 2, wy + 14, 24, SWATCH.yellow70Muted);
		buffer.vline(wx + 27, wy, 30, SWATCH.amber285Dusty);
		buffer.set(wx + 4, wy + 5, SWATCH.white10Muted);
		buffer.set(wx + 5, wy + 4, SWATCH.white10Muted);
		buffer.set(wx + 6, wy + 3, SWATCH.white10Muted);
		buffer.set(wx + 17, wy + 6, SWATCH.white10Muted);
		buffer.set(wx + 18, wy + 5, SWATCH.white10Muted);
		// Distant treetops through the lower panes.
		for (let i = 0; i < 24; i++) {
			const h = 3 + Math.floor(noise(i >> 1, x, 7) * 4);
			buffer.vline(
				wx + 2 + i,
				wy + 28 - h,
				h,
				i % 5 === 0 ? SWATCH.green605 : SWATCH.green555Muted
			);
		}
		buffer.hline(wx - 2, wy + 30, 32, SWATCH.orange555);
		buffer.hline(wx - 2, wy + 31, 32, SWATCH.orange735);
	}
}

/**
 * Behind each row of desks, one continuous partition wall joins the desk
 * nooks: a wooden top rail, papered panels, and a wainscot with a dark
 * baseboard, spanning the row's rug.
 */
function paintOfficeWalls(buffer: PixelBuffer, input: GroundInput): void {
	const { frame, layout } = input;
	const rows = new Map<number, number[]>();
	for (const entity of layout.entities) {
		const xs = rows.get(entity.y) ?? [];
		xs.push(entity.x);
		rows.set(entity.y, xs);
	}
	for (const [y, xs] of rows) {
		const fromX = Math.max(0, Math.min(...xs) - 2);
		const toX = Math.min(layout.width - 1, Math.max(...xs) + 2);
		const left = (fromX + frame.margin.x) * PX;
		const width = (toX - fromX + 1) * PX;
		const top = (y - 2 + frame.margin.y) * PX;
		for (let dy = 0; dy < 42; dy++) {
			for (let dx = 0; dx < width; dx++) {
				const gx = left + dx;
				let color: string;
				if (dy < 3) {
					color =
						[SWATCH.amber410Ashen, SWATCH.amber550, SWATCH.orange735][dy] ??
						SWATCH.orange735;
				} else if (dy < 28) {
					const stripe = Math.floor(gx / 4) % 2 === 0;
					color = stripe ? SWATCH.yellow190Dusty : SWATCH.amber235;
					if (dy === 3) {
						color = SWATCH.amber370;
					}
				} else if (dy < 30) {
					color = dy === 28 ? SWATCH.amber410Ashen : SWATCH.orange645;
				} else if (dy < 40) {
					const along = gx % 8;
					color =
						along === 0
							? SWATCH.orange780
							: along === 1
								? SWATCH.orange520
								: SWATCH.orange590;
				} else {
					color = dy === 40 ? SWATCH.orange825 : SWATCH.orange900;
				}
				if (dx === 0) {
					color = mix(color, SWATCH.yellow80, 0.25);
				} else if (dx === width - 1) {
					color = shade(color, 0.3);
				}
				buffer.set(gx, top + dy, color);
			}
		}
	}
}

/** Darkens every pixel under a shadow mask once, so overlaps never stack. */
function applyShadows(buffer: PixelBuffer, input: GroundInput): void {
	const mask = new Uint8Array(buffer.width * buffer.height);
	for (const s of input.shadows) {
		for (let y = Math.floor(s.cy - s.ry); y <= Math.ceil(s.cy + s.ry); y++) {
			for (let x = Math.floor(s.cx - s.rx); x <= Math.ceil(s.cx + s.rx); x++) {
				if (!buffer.inside(x, y)) {
					continue;
				}
				const dx = (x + 0.5 - s.cx) / s.rx;
				const dy = (y + 0.5 - s.cy) / s.ry;
				const r = dx * dx + dy * dy;
				if (r <= 1) {
					// Dithered soft rim.
					const level = r > 0.7 && bayer(x, y) < 0.5 ? 1 : 2;
					mask[y * buffer.width + x] = Math.max(
						mask[y * buffer.width + x] ?? 0,
						level
					);
				}
			}
		}
	}
	const [sr, sg, sb] = parseHex(input.scene.shadow);
	for (let i = 0; i < mask.length; i++) {
		const level = mask[i] ?? 0;
		if (level === 0) {
			continue;
		}
		const t = level === 2 ? 0.34 : 0.2;
		const o = i * 4;
		buffer.data[o] = (buffer.data[o] ?? 0) * (1 - t) + sr * t;
		buffer.data[o + 1] = (buffer.data[o + 1] ?? 0) * (1 - t) + sg * t;
		buffer.data[o + 2] = (buffer.data[o + 2] ?? 0) * (1 - t) + sb * t;
	}
}

/** Tufts, tall grass, wildflowers, pebbles and twigs, per 16x16 art tile. */
function paintDecals(buffer: PixelBuffer, input: GroundInput): void {
	const { frame, scene, village } = input;
	const flowerTiles = new Set(village.flowers.map((f) => tileKey(f.x, f.y)));
	const half = PX / 2;
	for (let ty = -frame.margin.y; ty < frame.rows - frame.margin.y; ty++) {
		for (let tx = -frame.margin.x; tx < frame.cols - frame.margin.x; tx++) {
			const material = materialAt(input, tx, ty);
			if (material !== "grass") {
				continue;
			}
			const key = tileKey(tx, ty);
			const blocked = input.props.blocking.has(key);
			const glade = !insideWorld(input.layout, tx, ty) && inClearing(tx, ty);
			for (let sub = 0; sub < 4; sub++) {
				const sx = (sub % 2) * half;
				const sy = Math.floor(sub / 2) * half;
				// Furniture stands on the bottom half of its tile.
				if (blocked && sy > 0) {
					continue;
				}
				const ox = (tx + frame.margin.x) * PX + sx;
				const oy = (ty + frame.margin.y) * PX + sy;
				const hash = tileHash(
					tx * 2 + (sub % 2) + 31,
					ty * 2 + (sub >> 1) + 17
				);
				const jx = hash % 9;
				const jy = (hash >> 3) % 9;
				if (hash < 240) {
					paintTuft(buffer, ox + 1 + jx, oy + 4 + jy, hash, scene);
				}
				if (glade && hash % 3 === 0) {
					paintTallGrass(buffer, ox + 1 + (jx >> 1), oy + 2 + (jy >> 1), scene);
				}
				if (hash > 300 && hash < 336) {
					paintTallGrass(buffer, ox + 3 + (jx >> 1), oy + 6 + (jy >> 1), scene);
				} else if (hash >= 336 && hash < 350) {
					paintPebble(buffer, ox + 3 + jx, oy + 5 + jy);
				} else if (hash >= 350 && hash < 355) {
					paintMushroom(buffer, ox + 4 + jx, oy + 4 + jy);
				} else if (hash >= 355 && hash < 365) {
					paintTwig(buffer, ox + 3 + jx, oy + 6 + jy);
				}
				const flowery = flowerTiles.has(key) && sub % 2 === 0;
				if (flowery || hash > 965 || (glade && hash > 780)) {
					const count = 1 + (hash % 3);
					for (let i = 0; i < count; i++) {
						paintFlower(
							buffer,
							ox + 2 + ((jx + i * 5) % 11),
							oy + 2 + ((jy + i * 4) % 10),
							hash + (i % 2),
							scene
						);
					}
				}
			}
		}
	}
}

/** The pond's ellipse in frame pixels, or null without a pond. */
function pondShape(
	input: GroundInput
): { cx: number; cy: number; rx: number; ry: number } | null {
	const { frame, props } = input;
	const pond = props.pond;
	if (!pond) {
		return null;
	}
	return {
		cx: (pond.x + frame.margin.x) * PX + (pond.w * PX) / 2,
		cy: (pond.y + frame.margin.y) * PX + (pond.h * PX) / 2,
		rx: (pond.w * PX) / 2 - 3,
		ry: (pond.h * PX) / 2 - 3,
	};
}

/**
 * An organic pond inside its tiles: grass around it, a dark green bank
 * line, a shadowed top edge where the bank overhangs, and still water with
 * a few light streaks.
 */
function waterColor(input: GroundInput, gx: number, gy: number): string {
	const { scene } = input;
	const shape = pondShape(input);
	if (!shape) {
		return grassColor(scene, gx, gy);
	}
	const dx = (gx + 0.5 - shape.cx) / shape.rx;
	const dy = (gy + 0.5 - shape.cy) / shape.ry;
	const wobble = (valueNoise(gx / 4, gy / 4, 211) - 0.5) * 0.16;
	const d = Math.hypot(dx, dy) + wobble;
	const inset = (1 - d) * Math.min(shape.rx, shape.ry);
	if (inset < 0) {
		return grassColor(scene, gx, gy);
	}
	if (inset < 1) {
		return shade(scene.grass[3], 0.45);
	}
	if (inset < 2 && dy > 0) {
		return scene.water.rim;
	}
	if (inset < 4 && dy < 0.2) {
		return scene.water.deep;
	}
	if (gy % 4 === 0 && noise(gx >> 2, gy, 223) < 0.12) {
		return scene.water.light;
	}
	return scene.water.fill;
}

function paintPondLilies(buffer: PixelBuffer, input: GroundInput): void {
	const shape = pondShape(input);
	if (!shape) {
		return;
	}
	const { cx, cy, rx, ry } = shape;
	paintLilyPad(
		buffer,
		Math.round(cx - rx * 0.55),
		Math.round(cy + ry * 0.05),
		true
	);
	paintLilyPad(
		buffer,
		Math.round(cx + rx * 0.2),
		Math.round(cy - ry * 0.35),
		false
	);
	paintLilyPad(
		buffer,
		Math.round(cx - rx * 0.1),
		Math.round(cy + ry * 0.45),
		true
	);
	if (rx > 20) {
		paintLilyPad(
			buffer,
			Math.round(cx + rx * 0.35),
			Math.round(cy + ry * 0.3),
			false
		);
	}
}

/**
 * A stone slab under each cottage door: a little narrower than the door's
 * frame, two pixels deep, outlined in dark stone, right at the wall's foot.
 */
function paintDoorsteps(buffer: PixelBuffer, input: GroundInput): void {
	const { frame, scene, village } = input;
	if (scene.indoor) {
		return;
	}
	const stone = SWATCH.amber325;
	const line = shade(stone, 0.5);
	for (const house of village.houses) {
		const x = (house.x + frame.margin.x) * PX + DOOR_RECT.x - 2;
		const y = (house.y + house.h + frame.margin.y) * PX;
		const w = DOOR_RECT.w + 4;
		buffer.rect(x - 1, y, w + 2, 4, line);
		buffer.rect(x, y, w, 3, stone);
		buffer.hline(x, y, w, light(stone, 0.3));
		buffer.vline(x + Math.floor(w / 2), y, 3, shade(stone, 0.22));
	}
}

/** Bakes the ground into a canvas covering the whole frame. */
export function buildGround(base: GroundInput): HTMLCanvasElement {
	const input: GroundInput = {
		...base,
		rugs: base.scene.indoor ? rugRects(base) : [],
	};
	const { frame, scene } = input;
	const buffer = new PixelBuffer(frame.cols * PX, frame.rows * PX);
	const wallTop = (frame.margin.y - WALL_ROWS) * PX;
	const rugAt = (wx: number, wy: number) =>
		(input.rugs ?? []).find((item) => inRect(item, wx, wy));
	const rugEdge = (rect: Rug | undefined, gx: number, gy: number) => {
		if (!rect) {
			return 99;
		}
		const left = (rect.x + frame.margin.x) * PX;
		const top = (rect.y + frame.margin.y) * PX;
		return Math.min(
			gx - left,
			gy - top,
			left + rect.w * PX - 1 - gx,
			top + rect.h * PX - 1 - gy
		);
	};
	for (let ty = 0; ty < frame.rows; ty++) {
		for (let tx = 0; tx < frame.cols; tx++) {
			const wx = tx - frame.margin.x;
			const wy = ty - frame.margin.y;
			const material = materialAt(input, wx, wy);
			const neighbors = new Map<string, boolean>();
			const open = (dx: number, dy: number) => {
				const key = `${dx},${dy}`;
				let value = neighbors.get(key);
				if (value === undefined) {
					value = paved(materialAt(input, wx + dx, wy + dy));
					neighbors.set(key, value);
				}
				return value;
			};
			// Where a dirt path meets the square, both sides fray.
			const other =
				material === "dirt" ? "cobble" : material === "cobble" ? "dirt" : null;
			const borders = (dx: number, dy: number) =>
				other !== null && materialAt(input, wx + dx, wy + dy) === other;
			const fray = !scene.indoor && SIDES.some(([dx, dy]) => borders(dx, dy));
			const origin = { x: tx * PX, y: ty * PX };
			for (let ly = 0; ly < PX; ly++) {
				for (let lx = 0; lx < PX; lx++) {
					const gx = tx * PX + lx;
					const gy = ty * PX + ly;
					let color: string;
					if (paved(material)) {
						const edge = edgeDistance(open, lx, ly);
						const hang = material === "dirt" ? overhang(gx, gy) : 0;
						const e = edge - hang;
						if (material === "dirt" && e < 0) {
							// Grass hanging over the path edge, lit at its tip.
							color = scene.indoor
								? floorColor(scene, gx, gy)
								: e >= -1
									? scene.grassTip
									: grassColor(scene, gx, gy);
						} else if (material === "cobble") {
							color = squareColor(scene, open, lx, ly, gx, gy, edge);
							if (fray && edge >= 7) {
								color =
									frayedCobble(scene, gx, gy, origin, borders, false) ??
									dirtColor(scene, gx, gy, 99);
							}
						} else if (material === "rug") {
							const rug = rugAt(wx, wy);
							color = rugColor(
								rugTone(scene, rug?.tone ?? 0),
								gx,
								gy,
								rugEdge(rug, gx, gy)
							);
						} else {
							color =
								(fray && e >= 1
									? frayedCobble(scene, gx, gy, origin, borders, true)
									: null) ?? dirtColor(scene, gx, gy, e);
						}
					} else if (material === "grass") {
						color = grassColor(scene, gx, gy);
					} else if (material === "floor") {
						color = floorColor(scene, gx, gy);
					} else if (material === "wall") {
						color = wallColor(gx, gy, wallTop);
					} else if (material === "water") {
						color = waterColor(input, gx, gy);
					} else if (material === "trim") {
						color = trimColor(input.layout, wx, wy, lx, ly);
					} else if (material === "front") {
						color = frontWallColor(
							gx,
							gy,
							(frame.margin.y + input.layout.height) * PX
						);
					} else if (scene.indoor) {
						// Beyond the walls: the building's darker floor.
						color = mix(floorColor(scene, gx, gy), scene.backdrop, 0.62);
					} else {
						color =
							noise(gx, gy, 107) < 0.02 ? SWATCH.warmGrey865 : scene.backdrop;
					}
					if (scene.indoor && insideWorld(input.layout, wx, wy)) {
						const dark = wallShadow(input.layout, wx, wy, lx, ly);
						if (dark > 0) {
							color = mix(color, scene.shadow, dark);
						}
					}
					buffer.set(gx, gy, color);
				}
			}
		}
	}
	if (scene.indoor) {
		paintWallWindows(buffer, input);
		paintOfficeWalls(buffer, input);
	} else {
		paintDecals(buffer, input);
		paintPondLilies(buffer, input);
	}
	paintDoorsteps(buffer, input);
	applyShadows(buffer, input);
	return buffer.toCanvas();
}

/** Mixes for the minimap's flat tile colors. */
export function minimapColor(
	scene: PixelScene,
	material: "grass" | "path" | "plaza"
): string {
	if (material === "path") {
		return scene.dirt.fill;
	}
	if (material === "plaza") {
		return scene.indoor ? scene.cobble.stones[0] : scene.cobble.stones[1];
	}
	return mix(scene.grass[0], scene.grass[1], 0.5);
}
