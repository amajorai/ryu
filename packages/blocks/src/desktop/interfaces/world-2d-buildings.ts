import { SWATCH } from "./world-2d-palette.ts";
import {
	light,
	mix,
	noise,
	PixelBuffer,
	pixelText,
	pixelTextWidth,
	type Sprite,
	shade,
	spriteCache,
	toSprite,
} from "./world-2d-pixel.ts";

/**
 * Pelican Town cottages and village furniture, drawn at native resolution.
 * A cottage fills its 3x2-tile footprint (48x32 art pixels) and its roof
 * rises a few pixels into the row behind: four rows of scalloped shingles
 * under a light ridge cap with a dark eave line and a brick chimney, over
 * horizontal plank walls with white-framed curtained windows, flower boxes
 * under both, and a framed plank door under a little hood.
 * Indoors the same footprint is a desk nook: a fabric partition with pinned
 * notes, a bookshelf, and a desk with a monitor.
 */

/** Buffer margin beside the footprint (eaves) and above it (roof, chimney). */
const HOUSE_PAD_X = 6;
const HOUSE_PAD_TOP = 30;
/** How far the roof ridge rises above the footprint into the row behind. */
const ROOF_RISE = 12;
/** Rows (from the ridge) over which the hipped ends slope in. */
const HIP_DEPTH = 18;
export const HOUSE_W = 96;
export const HOUSE_H = 64;

const WALLS = [
	{ fill: SWATCH.yellow170, line: SWATCH.amber335Muted, trim: SWATCH.amber535 },
	{
		fill: SWATCH.amber410Faded,
		line: SWATCH.amber555Muted,
		trim: SWATCH.orange690,
	},
	{ fill: SWATCH.amber220, line: SWATCH.amber380Muted, trim: SWATCH.orange600 },
	{ fill: SWATCH.cyan150, line: SWATCH.cyan300, trim: SWATCH.coolGrey495 },
] as const;

const CURTAINS = [
	SWATCH.red430,
	SWATCH.blue420,
	SWATCH.amber445,
	SWATCH.purple440,
	SWATCH.green525Muted,
	SWATCH.pink335,
];

export interface HouseStyle {
	lit: boolean;
	roof: string;
	variant: number;
}

/** Glass colors: daylight sky reflections, or warm lamplight. */
function glassTones(lit: boolean) {
	return lit
		? { dark: SWATCH.amber415, fill: SWATCH.yellow315, light: SWATCH.yellow155 }
		: { dark: SWATCH.blue455, fill: SWATCH.sky325Muted, light: SWATCH.sky135 };
}

/**
 * A white-framed four-pane window with curtains gathered at both sides.
 * (x, y) is the frame's top-left; the frame is 20x16 with 16x12 glass.
 */
function paintWindow(
	buffer: PixelBuffer,
	glow: PixelBuffer,
	x: number,
	y: number,
	lit: boolean,
	curtain: string
): void {
	const frame = SWATCH.yellow70Muted;
	const frameShade = SWATCH.amber285Dusty;
	buffer.rect(x, y, 20, 16, frame);
	buffer.hline(x, y + 15, 20, frameShade);
	buffer.vline(x + 19, y, 16, frameShade);
	const glass = glassTones(lit);
	buffer.rect(x + 2, y + 2, 16, 12, glass.fill);
	if (lit) {
		glow.rect(x + 2, y + 2, 16, 12, SWATCH.amber290);
	}
	// Mullions.
	buffer.vline(x + 10, y + 2, 12, frame);
	buffer.hline(x + 2, y + 7, 16, frame);
	if (lit) {
		buffer.rect(x + 4, y + 3, 3, 3, glass.light);
		buffer.rect(x + 12, y + 3, 3, 3, glass.light);
		glow.rect(x + 4, y + 3, 3, 3, SWATCH.yellow140);
		glow.rect(x + 12, y + 3, 3, 3, SWATCH.yellow140);
	} else {
		// Sky reflections: two short diagonal glints per upper pane.
		for (const px of [x + 4, x + 12]) {
			buffer.set(px, y + 4, glass.light);
			buffer.set(px + 1, y + 3, glass.light);
			buffer.set(px + 3, y + 5, glass.light);
		}
		buffer.hline(x + 2, y + 13, 8, glass.dark);
		buffer.hline(x + 11, y + 13, 7, glass.dark);
		buffer.vline(x + 9, y + 8, 5, glass.dark);
		buffer.vline(x + 17, y + 8, 5, glass.dark);
	}
	// Curtains gathered at both sides, tied a little below the middle.
	const dark = shade(curtain, 0.22);
	for (let dy = 0; dy < 12; dy++) {
		const width = dy < 7 ? 2 : dy < 9 ? 1 : 2;
		buffer.hline(
			x + 2,
			y + 2 + dy,
			width,
			dy === 0 ? light(curtain, 0.2) : curtain
		);
		buffer.hline(x + 18 - width, y + 2 + dy, width, dark);
		for (let i = 0; i < width; i++) {
			glow.clear(x + 2 + i, y + 2 + dy);
			glow.clear(x + 17 - i, y + 2 + dy);
		}
	}
	for (let i = 2; i < 18; i++) {
		glow.clear(x + i, y + 7);
	}
	for (let i = 2; i < 14; i++) {
		glow.clear(x + 10, y + i);
	}
	buffer.set(x + 2, y + 10, shade(curtain, 0.4));
	buffer.set(x + 17, y + 10, shade(curtain, 0.45));
	// Sill.
	buffer.hline(x - 1, y + 16, 22, frame);
	buffer.hline(x - 1, y + 17, 22, frameShade);
}

/** A planked flower box under a window, overflowing with blooms. */
function paintFlowerBox(
	buffer: PixelBuffer,
	x: number,
	y: number,
	seed: number
): void {
	const wood = SWATCH.orange610;
	buffer.rect(x, y + 2, 22, 5, wood);
	buffer.hline(x, y + 2, 22, light(wood, 0.25));
	buffer.hline(x, y + 6, 22, shade(wood, 0.35));
	buffer.vline(x + 7, y + 3, 3, shade(wood, 0.2));
	buffer.vline(x + 14, y + 3, 3, shade(wood, 0.2));
	const colors = [
		SWATCH.rose290,
		SWATCH.yellow385,
		SWATCH.white10Muted,
		SWATCH.violet260,
		SWATCH.amber380,
	];
	for (let i = 0; i < 7; i++) {
		const fx = x + 1 + i * 3;
		buffer.set(fx, y + 1, SWATCH.green585);
		buffer.set(fx + 1, y + 1, SWATCH.green675);
		buffer.set(fx + 1, y + 2, SWATCH.green675);
		const color = colors[(seed + i) % colors.length] ?? SWATCH.white10Muted;
		const top = y - (i % 2);
		buffer.set(fx, top, color);
		buffer.set(fx + 1, top, light(color, 0.3));
		buffer.set(fx, top - 1, shade(color, 0.15));
	}
}

/**
 * One fish-scale shingle, 8x5 (b body, L lit top, s and d its shading
 * toward the rounded bottom, k the notch between two scallops). Rows are
 * staggered by half a shingle, so each row's lit top shows in the notches
 * of the row above.
 */
const SHINGLE = [
	"bLLLLLLb",
	"bbbbbbbb",
	"sbbbbbbs",
	"dsbbbbsd",
	"kkddddkk",
] as const;

/** How far the hipped roof is pulled in at a row `yy` below the ridge. */
function hipInset(yy: number): number {
	return Math.max(0, Math.floor((HIP_DEPTH - yy) / 2));
}

/**
 * The roof's front slope, hipped at both ends: a rounded ridge cap, seven
 * rows of scalloped shingles (each shingle a touch different, lit from the
 * top-left and darkening toward the eave), stepped 2:1 hip lines in the
 * roof's deep shade, and a dark drip edge with the fascia's shadow under
 * it. It overhangs the walls by four pixels on each side.
 */
function paintRoof(
	buffer: PixelBuffer,
	ox: number,
	oy: number,
	roof: string,
	eave: number
): void {
	const tones = {
		dark: shade(roof, 0.34),
		deep: shade(roof, 0.52),
		ridge: light(roof, 0.36),
	};
	const left = ox - 4;
	const width = HOUSE_W + 8;
	const top = oy - ROOF_RISE;
	const rows = Math.floor((eave - (top + 4)) / 5);
	const span = (y: number) => {
		const inset = hipInset(y - top);
		return { from: left + inset, to: left + width - inset };
	};
	// Ridge cap: a lighter rounded beam along the top.
	for (let y = top; y < top + 3; y++) {
		const { from, to } = span(y);
		buffer.hline(from + 1, y, to - from - 2, tones.ridge);
	}
	const ridge = span(top);
	buffer.hline(
		ridge.from + 2,
		top,
		ridge.to - ridge.from - 4,
		light(roof, 0.6)
	);
	for (let x = ridge.from + 5; x < ridge.to - 3; x += 8) {
		buffer.vline(x, top + 1, 2, shade(tones.ridge, 0.2));
	}
	const cap = span(top + 3);
	buffer.hline(cap.from, top + 3, cap.to - cap.from, tones.dark);
	for (let row = 0; row < rows; row++) {
		const y0 = top + 4 + row * 5;
		// Rows step from a sunlit tone under the ridge to a cool shade at the
		// eave (hue-shifted, never just darker).
		const t = row / Math.max(1, rows - 1);
		const base =
			t < 0.34 ? light(roof, 0.16) : t < 0.67 ? roof : shade(roof, 0.16);
		const offset = row % 2 === 0 ? 0 : 4;
		for (let dy = 0; dy < 5; dy++) {
			const { from, to } = span(y0 + dy);
			const pattern = SHINGLE[dy] ?? "bbbbbbbb";
			for (let x = from; x < to; x++) {
				const local = (x - left + offset) % 8;
				const shingle = Math.floor((x - left + offset) / 8);
				// Hand-placed variety: one shingle in five sits a shade off.
				const tint = noise(shingle, row, 41);
				const own =
					tint < 0.18
						? shade(base, 0.08)
						: tint > 0.86
							? light(base, 0.08)
							: base;
				const key = pattern[local] ?? "b";
				const color =
					key === "L"
						? light(own, 0.24)
						: key === "s"
							? shade(own, 0.12)
							: key === "d"
								? shade(own, 0.28)
								: key === "k"
									? tones.dark
									: own;
				buffer.set(x, y0 + dy, color);
			}
		}
	}
	// Eave: the drip edge, then the fascia board's deep shadow.
	const drip = top + 4 + rows * 5;
	for (let y = drip; y < eave; y++) {
		buffer.hline(left, y, width, shade(roof, 0.2));
	}
	buffer.hline(left, eave, width, tones.dark);
	buffer.hline(left, eave + 1, width, tones.deep);
	// Hip lines and gable edges: the lit left hip, the shaded right one.
	for (let y = top + 1; y <= eave; y++) {
		const { from, to } = span(y);
		buffer.set(from, y, tones.dark);
		buffer.set(to - 1, y, tones.deep);
		if (hipInset(y - top) > 0) {
			buffer.set(from + 1, y, light(roof, 0.2));
			buffer.set(to - 2, y, tones.dark);
		}
	}
}

/** A little dormer window poking out of the roof, with its own roof. */
function paintDormer(
	buffer: PixelBuffer,
	glow: PixelBuffer,
	x: number,
	y: number,
	style: HouseStyle,
	wall: (typeof WALLS)[number]
): void {
	buffer.rect(x, y + 6, 22, 14, wall.fill);
	buffer.vline(x, y + 6, 14, wall.trim);
	buffer.vline(x + 21, y + 6, 14, shade(wall.trim, 0.2));
	const glass = glassTones(style.lit);
	buffer.rect(x + 6, y + 9, 10, 8, SWATCH.yellow70Muted);
	buffer.rect(x + 7, y + 10, 8, 6, glass.fill);
	buffer.vline(x + 11, y + 10, 6, SWATCH.yellow70Muted);
	buffer.set(x + 8, y + 11, glass.light);
	if (style.lit) {
		glow.rect(x + 7, y + 10, 8, 6, SWATCH.amber290);
	}
	buffer.hline(x, y + 19, 22, shade(style.roof, 0.4));
	// Its roof: a small peaked cap of three shingle rows.
	for (let row = 0; row < 7; row++) {
		const inset = Math.max(0, 6 - row * 2);
		buffer.hline(
			x - 2 + inset,
			y + row,
			26 - inset * 2,
			row === 0
				? light(style.roof, 0.4)
				: row % 3 === 0
					? shade(style.roof, 0.2)
					: style.roof
		);
	}
	buffer.hline(x - 2, y + 6, 26, shade(style.roof, 0.34));
}

function paintChimney(
	buffer: PixelBuffer,
	x: number,
	y: number,
	h: number
): void {
	const brick = SWATCH.orange530;
	const mortar = SWATCH.orange305;
	buffer.rect(x, y, 8, h, brick);
	for (let row = 0; row < h; row += 3) {
		buffer.hline(x, y + row + 2, 8, mortar);
		const joint = row % 6 === 0 ? 3 : 6;
		buffer.vline(x + joint, y + row, 2, mortar);
	}
	buffer.vline(x, y, h, light(brick, 0.15));
	buffer.vline(x + 7, y, h, shade(brick, 0.32));
	buffer.rect(x - 1, y - 3, 10, 3, SWATCH.warmGrey565);
	buffer.hline(x - 1, y - 3, 10, SWATCH.warmGrey415);
	buffer.rect(x + 1, y - 3, 6, 1, SWATCH.red805);
}

/** A shingled hood over the door on two little brackets. */
function paintDoorHood(
	buffer: PixelBuffer,
	x: number,
	y: number,
	width: number,
	roof: string
): void {
	buffer.rect(x, y, width, 4, light(roof, 0.1));
	for (let i = 2; i < width; i += 4) {
		buffer.vline(x + i, y + 1, 3, shade(roof, 0.22));
	}
	buffer.hline(x, y, width, light(roof, 0.38));
	buffer.hline(x, y + 4, width, shade(roof, 0.42));
	buffer.rect(x + 2, y + 5, 2, 3, SWATCH.orange690);
	buffer.rect(x + width - 4, y + 5, 2, 3, SWATCH.orange690);
}

/** Wall top in footprint pixels (just under the eave). */
const WALL_TOP = 31;
/** Door opening in footprint pixels: wider than a villager, full height. */
const DOOR = { h: 24, w: 16, x: 40, y: 40 } as const;
/** Window frames (20x16) in footprint pixels. */
const WINDOW_FRAMES = [
	{ x: 10, y: 37 },
	{ x: 66, y: 37 },
] as const;

function buildCottage(style: HouseStyle): Sprite {
	const width = HOUSE_W + HOUSE_PAD_X * 2;
	const height = HOUSE_H + HOUSE_PAD_TOP;
	const buffer = new PixelBuffer(width, height);
	const glow = new PixelBuffer(width, height);
	const ox = HOUSE_PAD_X;
	const oy = HOUSE_PAD_TOP;
	const wall = WALLS[style.variant % WALLS.length] ?? WALLS[0];
	const curtain = CURTAINS[style.variant % CURTAINS.length] ?? SWATCH.red430;
	// Horizontal plank walls (3px boards over a 1px seam), staggered joints.
	for (let y = WALL_TOP; y < HOUSE_H; y++) {
		for (let x = 0; x < HOUSE_W; x++) {
			const plank = Math.floor((y - WALL_TOP) / 4);
			const line = (y - WALL_TOP) % 4 === 3;
			const seam = (x + plank * 13) % 29 === 0;
			let color: string = line || seam ? wall.line : wall.fill;
			if (!line && (y - WALL_TOP) % 4 === 0 && noise(x >> 2, plank, 3) < 0.3) {
				color = light(wall.fill, 0.12);
			} else if (!line && noise(x >> 1, y, style.variant) < 0.04) {
				color = mix(wall.fill, wall.line, 0.5);
			}
			buffer.set(ox + x, oy + y, color);
		}
	}
	// The roof's cast shadow on the wall under the eaves.
	buffer.hline(ox, oy + WALL_TOP, HOUSE_W, shade(wall.line, 0.4));
	buffer.hline(ox, oy + WALL_TOP + 1, HOUSE_W, shade(wall.fill, 0.26));
	buffer.hline(ox, oy + WALL_TOP + 2, HOUSE_W, shade(wall.fill, 0.12));
	// Stone foundation along the ground.
	const stone = SWATCH.warmGrey395;
	buffer.rect(ox, oy + HOUSE_H - 5, HOUSE_W, 5, stone);
	buffer.hline(ox, oy + HOUSE_H - 5, HOUSE_W, light(stone, 0.3));
	buffer.hline(ox, oy + HOUSE_H - 1, HOUSE_W, shade(stone, 0.35));
	for (let x = 0; x < HOUSE_W; x += 1) {
		const course = (x + 3) % 9 === 0 || (x + 7) % 9 === 0;
		if ((x + 3) % 9 === 0) {
			buffer.vline(ox + x, oy + HOUSE_H - 4, 2, shade(stone, 0.3));
		}
		if (course && (x + 7) % 9 === 0) {
			buffer.vline(ox + x, oy + HOUSE_H - 2, 1, shade(stone, 0.3));
		}
	}
	buffer.hline(ox, oy + HOUSE_H - 3, HOUSE_W, shade(stone, 0.12));
	// Corner posts.
	for (const x of [0, HOUSE_W - 3]) {
		buffer.rect(ox + x, oy + WALL_TOP, 3, HOUSE_H - WALL_TOP - 5, wall.trim);
		buffer.vline(
			ox + x,
			oy + WALL_TOP,
			HOUSE_H - WALL_TOP - 5,
			light(wall.trim, 0.2)
		);
		buffer.vline(
			ox + x + 2,
			oy + WALL_TOP,
			HOUSE_H - WALL_TOP - 5,
			shade(wall.trim, 0.2)
		);
	}
	// Door: plank door in a trim frame with a two-pane window and a knob.
	const door = SWATCH.orange645;
	const dx = ox + DOOR.x;
	const dy = oy + DOOR.y;
	buffer.rect(dx - 3, dy - 3, DOOR.w + 6, DOOR.h + 3, wall.trim);
	buffer.vline(dx - 3, dy - 3, DOOR.h + 3, light(wall.trim, 0.25));
	buffer.hline(dx - 3, dy - 3, DOOR.w + 6, light(wall.trim, 0.25));
	buffer.vline(dx + DOOR.w + 2, dy - 3, DOOR.h + 3, shade(wall.trim, 0.25));
	buffer.rect(dx, dy, DOOR.w, DOOR.h, door);
	for (const col of [4, 8, 12]) {
		buffer.vline(dx + col, dy, DOOR.h, shade(door, 0.22));
	}
	buffer.vline(dx, dy, DOOR.h, light(door, 0.18));
	buffer.hline(dx, dy, DOOR.w, shade(door, 0.42));
	buffer.hline(dx + 1, dy + 13, DOOR.w - 2, shade(door, 0.28));
	const glass = glassTones(style.lit);
	buffer.rect(dx + 3, dy + 3, 10, 6, SWATCH.orange735);
	buffer.rect(dx + 4, dy + 4, 8, 4, glass.fill);
	buffer.vline(dx + 8, dy + 4, 4, SWATCH.orange735);
	buffer.set(dx + 5, dy + 4, glass.light);
	if (style.lit) {
		glow.rect(dx + 4, dy + 4, 8, 4, SWATCH.amber290);
		for (let i = 0; i < 4; i++) {
			glow.clear(dx + 8, dy + 4 + i);
		}
	}
	buffer.rect(dx + 12, dy + 14, 2, 2, SWATCH.yellow375);
	buffer.set(dx + 13, dy + 15, SWATCH.amber590);
	// Windows with flower boxes under both.
	WINDOW_FRAMES.forEach((frame, index) => {
		paintWindow(buffer, glow, ox + frame.x, oy + frame.y, style.lit, curtain);
		paintFlowerBox(
			buffer,
			ox + frame.x - 1,
			oy + frame.y + 18,
			style.variant + index * 2
		);
	});
	paintChimney(buffer, ox + 70, oy - ROOF_RISE - 12, 20);
	// A stone step in front of the door, in the doorstep's top edge.
	const step = SWATCH.warmGrey320;
	buffer.rect(dx - 4, oy + HOUSE_H - 3, DOOR.w + 8, 3, step);
	buffer.hline(dx - 4, oy + HOUSE_H - 3, DOOR.w + 8, light(step, 0.3));
	buffer.hline(dx - 4, oy + HOUSE_H - 1, DOOR.w + 8, shade(step, 0.35));
	buffer.vline(dx + 4, oy + HOUSE_H - 2, 1, shade(step, 0.2));
	buffer.vline(dx + 13, oy + HOUSE_H - 2, 1, shade(step, 0.2));
	paintRoof(buffer, ox, oy, style.roof, oy + WALL_TOP - 2);
	if (style.variant % 2 === 0) {
		paintDormer(buffer, glow, ox + 37, oy - 2, style, wall);
	}
	paintDoorHood(buffer, dx - 6, oy + WALL_TOP + 2, DOOR.w + 12, style.roof);
	buffer.outline(0.5);
	return toSprite(buffer, HOUSE_PAD_X, HOUSE_PAD_TOP, glow);
}

/**
 * The indoor theme's desk nook, behind the desk: a cubicle partition with
 * pinned notes, a calendar and a wall shelf, and the desk chair's tall back
 * (the villager sits in front of it, behind the desk).
 */
function buildDeskNook(style: HouseStyle): Sprite {
	const width = HOUSE_W + HOUSE_PAD_X * 2;
	const height = HOUSE_H + HOUSE_PAD_TOP;
	const buffer = new PixelBuffer(width, height);
	const ox = HOUSE_PAD_X;
	const oy = HOUSE_PAD_TOP;
	const fabric = mix(style.roof, SWATCH.amber155Dusty, 0.4);
	// Partition panel with a wooden top rail and a weave of darker threads.
	buffer.rect(ox, oy + 2, HOUSE_W, 38, fabric);
	for (let y = oy + 3; y < oy + 40; y++) {
		for (let x = ox; x < ox + HOUSE_W; x++) {
			if ((x + y * 3) % 7 === 0 && noise(x >> 1, y >> 1, 5) < 0.5) {
				buffer.set(x, y, shade(fabric, 0.07));
			}
		}
	}
	buffer.rect(ox - 1, oy - 1, HOUSE_W + 2, 3, SWATCH.amber550);
	buffer.hline(ox - 1, oy - 1, HOUSE_W + 2, SWATCH.amber410Ashen);
	buffer.hline(ox, oy + 40, HOUSE_W, shade(fabric, 0.35));
	buffer.vline(ox, oy + 2, 38, light(fabric, 0.15));
	buffer.vline(ox + HOUSE_W - 1, oy + 2, 38, shade(fabric, 0.2));
	// Pinned notes and a calendar.
	const notes = [
		SWATCH.yellow185,
		SWATCH.pink115,
		SWATCH.sky125,
		SWATCH.green185,
	];
	for (let i = 0; i < 3; i++) {
		const nx = ox + 6 + i * 9 + (style.variant % 3);
		const ny = oy + 8 + ((i + style.variant) % 2) * 5;
		buffer.rect(
			nx,
			ny,
			7,
			7,
			notes[(i + style.variant) % notes.length] ?? SWATCH.white10Muted
		);
		buffer.hline(nx + 1, ny + 2, 5, SWATCH.warmGrey520);
		buffer.hline(nx + 1, ny + 4, 4, SWATCH.warmGrey520);
		buffer.set(nx + 3, ny, SWATCH.red460);
	}
	const cx = ox + 66;
	buffer.rect(cx, oy + 6, 18, 16, SWATCH.yellow30);
	buffer.rect(cx, oy + 6, 18, 4, SWATCH.red430);
	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 5; col++) {
			buffer.set(cx + 2 + col * 3, oy + 12 + row * 3, SWATCH.warmGrey440);
		}
	}
	buffer.set(cx + 8, oy + 15, SWATCH.red460);
	// A wall shelf with books over the right half.
	buffer.rect(ox + 62, oy + 28, 30, 2, SWATCH.orange645);
	buffer.hline(ox + 62, oy + 28, 30, SWATCH.amber460Muted);
	const books = [
		SWATCH.red430,
		SWATCH.blue420,
		SWATCH.amber445,
		SWATCH.green525Muted,
		SWATCH.purple440,
	];
	for (let i = 0; i < 8; i++) {
		const bh = 5 + ((i * 7 + style.variant) % 3);
		buffer.rect(
			ox + 64 + i * 3,
			oy + 28 - bh,
			2,
			bh,
			books[(i + style.variant) % books.length] ?? SWATCH.white10Muted
		);
	}
	// The chair's tall back, behind where the villager sits.
	const chair = SWATCH.blue635;
	const back = { h: 22, w: 22, x: ox + 37, y: oy + 34 };
	buffer.rect(back.x + 1, back.y, back.w - 2, back.h, chair);
	buffer.rect(back.x, back.y + 1, back.w, back.h - 2, chair);
	buffer.hline(back.x + 2, back.y + 1, back.w - 4, light(chair, 0.3));
	buffer.vline(back.x + 1, back.y + 2, back.h - 4, light(chair, 0.15));
	buffer.vline(back.x + back.w - 2, back.y + 2, back.h - 4, shade(chair, 0.3));
	buffer.rect(back.x + 9, back.y + back.h, 4, 6, SWATCH.coolGrey735);
	buffer.outline(0.5);
	return toSprite(buffer, HOUSE_PAD_X, HOUSE_PAD_TOP);
}

const houseSprites = spriteCache((style: HouseStyle, indoor: boolean) =>
	indoor ? buildDeskNook(style) : buildCottage(style)
);

/** A cottage (or desk nook) whose anchor is the footprint's top-left. */
export function houseSprite(style: HouseStyle, indoor: boolean): Sprite {
	return houseSprites(
		`${style.roof}|${style.variant % 12}|${style.lit}|${indoor}`,
		style,
		indoor
	);
}

/**
 * The desk in front of an indoor villager's nook, standing on the
 * villager's own tile: its top and front hide the villager's legs so they
 * sit behind it, a monitor on the left (lit while the agent works), a
 * keyboard in front of them, and a mug, papers and a plant on the right.
 * The anchor is the tile's top-left; the sprite sorts below the villager.
 */
function buildDesk(lit: boolean, variant: number): Sprite {
	const buffer = new PixelBuffer(HOUSE_W + 4, 52);
	const glow = new PixelBuffer(HOUSE_W + 4, 52);
	const ox = 2;
	const top = 26;
	const wood = SWATCH.amber375;
	// Monitor on its stand (left), screen toward the villager.
	const mx = ox + 8;
	buffer.rect(mx, top - 20, 26, 18, SWATCH.coolGrey735);
	buffer.rect(mx + 2, top - 18, 22, 13, lit ? SWATCH.sky325 : SWATCH.blue755);
	if (lit) {
		glow.rect(mx + 2, top - 18, 22, 13, SWATCH.sky400);
		for (let row = 0; row < 5; row++) {
			buffer.hline(
				mx + 4 + (row % 2) * 2,
				top - 16 + row * 2,
				8 + ((row * 5) % 9),
				SWATCH.cyan50
			);
		}
	} else {
		buffer.hline(mx + 4, top - 16, 3, SWATCH.blue605);
		buffer.set(mx + 20, top - 8, SWATCH.blue605);
	}
	buffer.rect(mx + 11, top - 2, 4, 3, SWATCH.coolGrey735);
	buffer.rect(mx + 7, top, 12, 2, SWATCH.coolGrey800);
	// Desk top and front.
	buffer.rect(ox + 6, top, HOUSE_W - 12, 7, wood);
	buffer.hline(ox + 6, top, HOUSE_W - 12, light(wood, 0.3));
	buffer.hline(ox + 6, top + 6, HOUSE_W - 12, shade(wood, 0.25));
	buffer.rect(ox + 6, top + 7, HOUSE_W - 12, 17, SWATCH.orange555);
	buffer.hline(ox + 6, top + 7, HOUSE_W - 12, shade(wood, 0.4));
	for (const x of [14, 70]) {
		buffer.rect(ox + x, top + 9, 12, 13, SWATCH.orange595);
		buffer.hline(ox + x, top + 9, 12, light(SWATCH.orange595, 0.2));
		buffer.rect(ox + x + 4, top + 14, 4, 2, SWATCH.amber410Muted);
	}
	buffer.vline(ox + 6, top + 7, 17, light(SWATCH.orange555, 0.15));
	// Keyboard, mug, papers, plant.
	buffer.rect(ox + 40, top + 1, 16, 4, SWATCH.amber115Muted);
	for (let i = 0; i < 7; i++) {
		buffer.set(ox + 41 + i * 2, top + 2, SWATCH.warmGrey315);
		buffer.set(ox + 42 + i * 2, top + 3, SWATCH.warmGrey315);
	}
	buffer.rect(ox + 62, top - 4, 5, 6, SWATCH.grey50);
	buffer.vline(ox + 67, top - 3, 3, SWATCH.grey185);
	buffer.hline(ox + 62, top - 4, 5, SWATCH.orange680);
	buffer.rect(ox + 70, top - 1, 11, 4, SWATCH.yellow30);
	buffer.hline(ox + 71, top, 8, SWATCH.warmGrey310);
	const pot = variant % 2 === 0 ? SWATCH.orange490 : SWATCH.blue455Muted;
	buffer.rect(ox + 83, top - 5, 6, 6, pot);
	buffer.hline(ox + 83, top - 5, 6, light(pot, 0.25));
	buffer.ellipse(ox + 86, top - 9, 5, 4.5, SWATCH.green555Dusty);
	buffer.ellipse(ox + 84.5, top - 10.5, 2.5, 2, SWATCH.green445);
	buffer.outline(0.5);
	return toSprite(buffer, ox, top - 4, lit ? glow : undefined);
}

const deskSprites = spriteCache(buildDesk);

export function deskSprite(lit: boolean, variant: number): Sprite {
	return deskSprites(`${lit}|${variant % 2}`, lit, variant % 2);
}

/** Chimney top in footprint pixels, for the smoke puffs. */
export const CHIMNEY_TOP = { x: 74, y: -ROOF_RISE - 15 } as const;
/** Glass of each window in footprint pixels (night light). */
export const WINDOW_PANES = WINDOW_FRAMES.map((frame) => ({
	h: 12,
	w: 16,
	x: frame.x + 2,
	y: frame.y + 2,
}));
/** The door's glass, in footprint pixels. */
export const DOOR_PANE = { h: 4, w: 8, x: DOOR.x + 4, y: DOOR.y + 4 } as const;
/** The door's opening in footprint pixels (for the doorstep). */
export const DOOR_RECT = DOOR;

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

function buildLamp(lit: boolean): Sprite {
	const buffer = new PixelBuffer(16, 46);
	const glow = new PixelBuffer(16, 46);
	const iron = SWATCH.coolGrey740;
	const ironLight = SWATCH.coolGrey550;
	buffer.rect(7, 13, 2, 28, iron);
	buffer.vline(7, 13, 28, ironLight);
	buffer.rect(5, 41, 6, 4, iron);
	buffer.hline(5, 41, 6, ironLight);
	buffer.rect(6, 38, 4, 3, iron);
	buffer.rect(6, 20, 4, 2, iron);
	// Lantern with a little peaked cap and a finial.
	buffer.rect(4, 3, 8, 2, iron);
	buffer.rect(5, 1, 6, 2, iron);
	buffer.set(7, 0, iron);
	buffer.set(8, 0, iron);
	buffer.rect(4, 5, 8, 7, iron);
	buffer.rect(5, 5, 6, 6, lit ? SWATCH.yellow260 : SWATCH.yellow160);
	buffer.rect(6, 6, 2, 3, lit ? SWATCH.yellow90 : SWATCH.white10Muted);
	buffer.vline(10, 5, 6, lit ? SWATCH.amber405 : SWATCH.yellow285Muted);
	buffer.vline(8, 5, 6, iron);
	buffer.rect(5, 11, 6, 2, iron);
	if (lit) {
		glow.rect(5, 5, 6, 6, SWATCH.amber260);
		glow.rect(6, 6, 2, 3, SWATCH.yellow100);
	}
	buffer.outline(0.45);
	return toSprite(buffer, 8, 45, lit ? glow : undefined);
}

const lampSprites = spriteCache(buildLamp);
export function lampSprite(lit: boolean): Sprite {
	return lampSprites(String(lit), lit);
}
/** Light source of a lamp, relative to its anchor. */
export const LAMP_LIGHT = { x: 0, y: -37 } as const;

/**
 * The town square's fountain: a low round basin of pale stone blocks, a
 * short pedestal with a shallow bowl, and the water's surface. The jet,
 * the spilling streams and the ripples are animated by the renderer at
 * `FOUNTAIN_SPOUT` and `FOUNTAIN_POOL`.
 */
function buildFountain(): Sprite {
	const w = 70;
	const h = 38;
	const buffer = new PixelBuffer(w, h);
	const stone = SWATCH.amber300;
	const cx = 35;
	const cy = 25;
	// Outer wall of the basin (front face), then the rim and the water.
	buffer.ellipse(cx, cy + 3, 32, 9.5, shade(stone, 0.25));
	buffer.ellipse(cx, cy, 32, 9.5, stone);
	for (let y = cy; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (buffer.alpha(x, y) === 0) {
				continue;
			}
			const dx = (x + 0.5 - cx) / 32;
			const rim = Math.sqrt(Math.max(0, 1 - dx * dx));
			if ((y + 0.5 - cy) / 9.5 < rim - 0.3) {
				continue;
			}
			const block =
				(x + (Math.floor((y - cy) / 3) % 2) * 4) % 8 === 0 ||
				(y - cy) % 3 === 2;
			let base: string = stone;
			if (dx < -0.25) {
				base = light(stone, 0.1);
			} else if (dx > 0.45) {
				base = shade(stone, 0.18);
			}
			buffer.set(x, y, block ? shade(stone, 0.3) : base);
		}
	}
	buffer.ellipse(cx, cy - 1, 29, 7.4, light(stone, 0.22));
	buffer.ellipse(cx, cy - 1, 26, 6, SWATCH.sky490);
	buffer.ellipse(cx, cy - 0.4, 25, 4.8, SWATCH.sky425);
	for (const [x, y] of [
		[cx - 17, cy - 1],
		[cx + 9, cy + 1],
		[cx - 6, cy + 2],
		[cx + 17, cy - 2],
	] as const) {
		buffer.hline(x, y, 4, SWATCH.sky225);
	}
	// A short pedestal and the upper bowl.
	buffer.rect(cx - 3, cy - 14, 6, 14, stone);
	buffer.vline(cx - 3, cy - 14, 14, light(stone, 0.25));
	buffer.vline(cx + 2, cy - 14, 14, shade(stone, 0.3));
	buffer.hline(cx - 3, cy - 6, 6, shade(stone, 0.2));
	buffer.ellipse(cx, cy - 15, 11, 3.6, shade(stone, 0.2));
	buffer.ellipse(cx, cy - 16, 11, 3, stone);
	buffer.ellipse(cx, cy - 16.4, 8.4, 1.9, SWATCH.sky425);
	buffer.hline(cx - 5, cy - 17, 3, SWATCH.sky225);
	// The spout.
	buffer.rect(cx - 1, cy - 22, 2, 6, light(stone, 0.15));
	buffer.rect(cx - 2, cy - 23, 4, 2, stone);
	buffer.outline(0.5);
	return toSprite(buffer, cx, h - 4);
}

let fountainCache: Sprite | null = null;
export function fountainSprite(): Sprite {
	fountainCache ??= buildFountain();
	return fountainCache;
}
/** The spout's tip and the basin's water, relative to the anchor. */
export const FOUNTAIN_SPOUT = { x: 0, y: -32 } as const;
export const FOUNTAIN_POOL = { rx: 24, ry: 5, x: 0, y: -9 } as const;

function buildMailbox(color: string): Sprite {
	const buffer = new PixelBuffer(16, 20);
	const post = SWATCH.orange630;
	buffer.rect(6, 9, 2, 9, post);
	buffer.vline(7, 9, 9, shade(post, 0.3));
	buffer.rect(4, 17, 6, 1, shade(post, 0.2));
	// A rounded-top box.
	buffer.rect(2, 3, 10, 6, color);
	buffer.hline(3, 2, 8, color);
	buffer.hline(3, 3, 8, light(color, 0.3));
	buffer.vline(2, 4, 4, light(color, 0.15));
	buffer.hline(3, 8, 9, shade(color, 0.35));
	buffer.vline(11, 3, 5, shade(color, 0.25));
	buffer.rect(3, 5, 2, 2, shade(color, 0.45));
	// Flag (up: there is news).
	buffer.rect(12, 2, 1, 6, SWATCH.grey710);
	buffer.rect(12, 2, 3, 2, SWATCH.red435);
	buffer.outline(0.5);
	return toSprite(buffer, 7, 19);
}

const mailboxSprites = spriteCache(buildMailbox);
export function mailboxSprite(color: string): Sprite {
	return mailboxSprites(color, color);
}

function buildBench(indoor: boolean): Sprite {
	const buffer = new PixelBuffer(24, 20);
	if (indoor) {
		const cloth = SWATCH.blue455Muted;
		buffer.rect(1, 4, 22, 8, shade(cloth, 0.1));
		buffer.rect(2, 2, 20, 4, cloth);
		buffer.hline(2, 2, 20, light(cloth, 0.3));
		buffer.rect(0, 6, 4, 9, shade(cloth, 0.2));
		buffer.rect(20, 6, 4, 9, shade(cloth, 0.3));
		buffer.rect(3, 10, 18, 5, cloth);
		buffer.hline(3, 10, 18, light(cloth, 0.2));
		buffer.vline(12, 10, 5, shade(cloth, 0.2));
		buffer.rect(2, 15, 2, 2, SWATCH.orange755);
		buffer.rect(20, 15, 2, 2, SWATCH.orange755);
		buffer.outline(0.5);
		return toSprite(buffer, 12, 18);
	}
	const wood = SWATCH.amber555;
	// Backrest slats.
	buffer.rect(2, 2, 20, 2, wood);
	buffer.hline(2, 2, 20, light(wood, 0.3));
	buffer.rect(2, 5, 20, 2, shade(wood, 0.08));
	// Seat.
	buffer.rect(1, 9, 22, 3, light(wood, 0.1));
	buffer.hline(1, 9, 22, light(wood, 0.35));
	buffer.hline(1, 11, 22, shade(wood, 0.25));
	// Legs and arms (iron).
	for (const x of [2, 20]) {
		buffer.rect(x, 1, 2, 16, SWATCH.coolGrey695);
		buffer.vline(x, 1, 16, SWATCH.coolGrey545);
	}
	buffer.outline(0.5);
	return toSprite(buffer, 12, 18);
}

const benchSprites = spriteCache(buildBench);
export function benchSprite(indoor: boolean): Sprite {
	return benchSprites(String(indoor), indoor);
}

function buildWell(indoor: boolean): Sprite {
	if (indoor) {
		// Water cooler.
		const buffer = new PixelBuffer(14, 30);
		buffer.rect(3, 1, 8, 10, SWATCH.sky210);
		buffer.vline(4, 2, 8, SWATCH.sky75);
		buffer.rect(4, 0, 6, 1, SWATCH.sky390);
		buffer.rect(2, 11, 10, 17, SWATCH.grey90);
		buffer.vline(2, 11, 17, SWATCH.white10Muted);
		buffer.vline(11, 11, 17, SWATCH.coolGrey280);
		buffer.rect(5, 15, 4, 3, SWATCH.coolGrey735);
		buffer.set(5, 16, SWATCH.red435);
		buffer.set(8, 16, SWATCH.blue420);
		buffer.outline(0.5);
		return toSprite(buffer, 7, 29);
	}
	const buffer = new PixelBuffer(28, 36);
	const stone = SWATCH.warmGrey375;
	// Stone ring.
	buffer.ellipse(14, 26, 11, 7, stone);
	for (let y = 19; y < 34; y++) {
		for (let x = 3; x < 25; x++) {
			if (buffer.alpha(x, y) === 0) {
				continue;
			}
			const brick = (x + (Math.floor(y / 3) % 2) * 2) % 5 === 0 || y % 3 === 0;
			const lit = x < 12 ? 0.12 : -0.18;
			buffer.set(
				x,
				y,
				brick
					? shade(stone, 0.3)
					: lit > 0
						? light(stone, lit)
						: shade(stone, -lit)
			);
		}
	}
	buffer.ellipse(14, 23, 8, 3.5, SWATCH.blue775);
	buffer.ellipse(14, 23.5, 6, 2.2, SWATCH.sky595);
	// Posts and a little shingle roof.
	const wood = SWATCH.orange630;
	buffer.rect(4, 8, 2, 16, wood);
	buffer.rect(22, 8, 2, 16, shade(wood, 0.2));
	buffer.rect(5, 12, 18, 1, shade(wood, 0.35));
	const roof = SWATCH.red530;
	for (let y = 2; y < 10; y++) {
		const inset = Math.max(0, 5 - y);
		buffer.hline(
			1 + inset,
			y,
			26 - inset * 2,
			y % 3 === 1 ? shade(roof, 0.2) : roof
		);
	}
	buffer.hline(3, 1, 22, light(roof, 0.35));
	// Bucket on the rope.
	buffer.vline(14, 13, 4, SWATCH.amber305);
	buffer.rect(12, 17, 5, 3, SWATCH.amber585);
	buffer.hline(12, 17, 5, SWATCH.amber470);
	buffer.outline(0.5);
	return toSprite(buffer, 14, 34);
}

const wellSprites = spriteCache(buildWell);
export function wellSprite(indoor: boolean): Sprite {
	return wellSprites(String(indoor), indoor);
}

function buildBoard(indoor: boolean): Sprite {
	const buffer = new PixelBuffer(26, 30);
	if (indoor) {
		buffer.rect(1, 2, 24, 16, SWATCH.coolGrey195);
		buffer.rect(2, 3, 22, 14, SWATCH.white10);
		buffer.hline(4, 6, 10, SWATCH.blue420);
		buffer.hline(4, 9, 14, SWATCH.red435);
		buffer.hline(4, 12, 8, SWATCH.green595);
		buffer.rect(16, 11, 5, 4, SWATCH.yellow185);
		buffer.rect(5, 18, 2, 10, SWATCH.coolGrey555);
		buffer.rect(19, 18, 2, 10, SWATCH.coolGrey555);
		buffer.outline(0.5);
		return toSprite(buffer, 13, 29);
	}
	const wood = SWATCH.orange610;
	buffer.rect(3, 12, 2, 16, shade(wood, 0.15));
	buffer.rect(21, 12, 2, 16, shade(wood, 0.3));
	buffer.rect(1, 3, 24, 14, wood);
	buffer.hline(1, 3, 24, light(wood, 0.3));
	buffer.rect(2, 4, 22, 12, SWATCH.amber445Muted);
	for (let y = 5; y < 16; y += 3) {
		buffer.hline(2, y, 22, shade(SWATCH.amber445Muted, 0.12));
	}
	// Notices.
	const papers = [
		[4, 5, 6, 7, SWATCH.yellow75],
		[12, 6, 5, 6, SWATCH.white10Muted],
		[18, 5, 5, 8, SWATCH.yellow190Muted],
	] as const;
	for (const [x, y, w, h, color] of papers) {
		buffer.rect(x, y, w, h, color);
		buffer.hline(x + 1, y + 2, w - 2, SWATCH.amber420Muted);
		buffer.hline(x + 1, y + 4, w - 2, SWATCH.amber420Muted);
		buffer.set(x + Math.floor(w / 2), y, SWATCH.red460);
	}
	// Little roof.
	buffer.rect(0, 1, 26, 2, SWATCH.orange735);
	buffer.hline(0, 0, 26, SWATCH.orange645);
	buffer.outline(0.5);
	return toSprite(buffer, 13, 29);
}

const boardSprites = spriteCache(buildBoard);
export function boardSprite(indoor: boolean): Sprite {
	return boardSprites(String(indoor), indoor);
}

function buildPlanter(seed: number): Sprite {
	const buffer = new PixelBuffer(30, 20);
	const wood = SWATCH.orange580;
	buffer.rect(1, 9, 28, 8, wood);
	buffer.hline(1, 9, 28, light(wood, 0.3));
	buffer.hline(1, 16, 28, shade(wood, 0.35));
	for (const x of [7, 14, 21]) {
		buffer.vline(x, 10, 6, shade(wood, 0.18));
	}
	buffer.rect(1, 9, 2, 8, shade(wood, 0.1));
	buffer.rect(27, 9, 2, 8, shade(wood, 0.25));
	const colors = [
		SWATCH.rose290,
		SWATCH.yellow385,
		SWATCH.blue260,
		SWATCH.white10Muted,
		SWATCH.amber380,
	];
	for (let i = 0; i < 8; i++) {
		const x = 2 + i * 3 + (i % 2);
		const y = 2 + ((i * 5 + seed) % 3);
		buffer.vline(x + 1, y + 3, 9 - y, SWATCH.green640);
		buffer.set(x, y + 5, SWATCH.green555);
		buffer.set(x + 2, y + 4, SWATCH.green555);
		const color = colors[(seed + i) % colors.length] ?? SWATCH.white10Muted;
		buffer.set(x + 1, y, color);
		buffer.set(x, y + 1, color);
		buffer.set(x + 2, y + 1, shade(color, 0.15));
		buffer.set(x + 1, y + 2, shade(color, 0.2));
		buffer.set(x + 1, y + 1, SWATCH.yellow375);
	}
	buffer.outline(0.5);
	return toSprite(buffer, 15, 18);
}

const planterSprites = spriteCache(buildPlanter);
export function planterSprite(seed: number): Sprite {
	return planterSprites(String(seed % 5), seed % 5);
}

function buildSign(lines: readonly string[]): Sprite {
	const textW = Math.max(...lines.map(pixelTextWidth));
	const w = textW + 8;
	const h = lines.length * 7 + 4;
	const buffer = new PixelBuffer(w + 2, h + 12);
	const wood = SWATCH.amber555;
	buffer.rect(4, h, 2, 10, shade(wood, 0.25));
	buffer.rect(w - 4, h, 2, 10, shade(wood, 0.35));
	buffer.rect(1, 1, w, h, wood);
	buffer.hline(1, 1, w, light(wood, 0.35));
	buffer.vline(1, 1, h, light(wood, 0.2));
	buffer.hline(1, h, w, shade(wood, 0.35));
	buffer.vline(w, 1, h, shade(wood, 0.3));
	for (let y = 4; y < h; y += 4) {
		for (let x = 3; x < w - 1; x++) {
			if (noise(x, y, 77) < 0.3) {
				buffer.set(x, y, shade(wood, 0.1));
			}
		}
	}
	lines.forEach((line, index) => {
		const x = 1 + Math.round((w - pixelTextWidth(line)) / 2);
		pixelText(buffer, line, x, 4 + index * 7, SWATCH.orange825);
		pixelText(buffer, line, x, 3 + index * 7, SWATCH.yellow95);
	});
	buffer.outline(0.5);
	return toSprite(buffer, Math.round((w + 2) / 2), h + 11);
}

const signSprites = spriteCache(buildSign);
export function signSprite(lines: readonly string[]): Sprite {
	return signSprites(lines.join("|"), lines);
}

function buildBarrel(crate: boolean): Sprite {
	const buffer = new PixelBuffer(16, 18);
	if (crate) {
		const wood = SWATCH.amber470;
		buffer.rect(2, 4, 12, 12, wood);
		buffer.rect(2, 4, 12, 3, light(wood, 0.25));
		buffer.hline(2, 7, 12, shade(wood, 0.3));
		for (let y = 9; y < 16; y += 3) {
			buffer.hline(2, y, 12, shade(wood, 0.15));
		}
		buffer.vline(2, 7, 9, shade(wood, 0.35));
		buffer.vline(13, 7, 9, shade(wood, 0.35));
		buffer.outline(0.5);
		return toSprite(buffer, 8, 17);
	}
	const wood = SWATCH.orange580;
	buffer.ellipse(8, 5, 6, 2.5, light(wood, 0.25));
	buffer.rect(2, 5, 12, 11, wood);
	buffer.ellipse(8, 15.5, 6, 1.5, wood);
	buffer.vline(3, 6, 9, light(wood, 0.15));
	buffer.vline(12, 6, 9, shade(wood, 0.3));
	for (const y of [7, 13]) {
		buffer.hline(2, y, 12, SWATCH.coolGrey650);
	}
	buffer.ellipse(8, 5, 4, 1.5, shade(wood, 0.2));
	buffer.outline(0.5);
	return toSprite(buffer, 8, 17);
}

const barrelSprites = spriteCache(buildBarrel);
export function barrelSprite(crate: boolean): Sprite {
	return barrelSprites(String(crate), crate);
}

/**
 * One tile of white picket fence: eight pointed pickets on two rails, a
 * post at each end, so neighboring tiles join into one fence line.
 */
function buildFence(): Sprite {
	const buffer = new PixelBuffer(34, 24);
	const wood = SWATCH.amber145Muted;
	const shadeWood = SWATCH.amber330;
	buffer.rect(1, 10, 32, 2, shadeWood);
	buffer.rect(1, 16, 32, 2, shadeWood);
	buffer.hline(1, 10, 32, wood);
	buffer.hline(1, 16, 32, wood);
	for (let i = 0; i < 8; i++) {
		const x = 2 + i * 4;
		buffer.rect(x, 5, 3, 16, wood);
		buffer.set(x + 1, 4, wood);
		buffer.vline(x + 2, 5, 16, shadeWood);
		buffer.set(x, 20, shadeWood);
	}
	for (const x of [0, 31]) {
		buffer.rect(x + 1, 3, 2, 19, SWATCH.amber225);
		buffer.vline(x + 2, 3, 19, shadeWood);
		buffer.hline(x + 1, 2, 2, SWATCH.yellow70);
	}
	buffer.outline(0.55);
	return toSprite(buffer, 17, 22);
}

let fenceCache: Sprite | null = null;
export function fenceSprite(): Sprite {
	fenceCache ??= buildFence();
	return fenceCache;
}

/** A bookshelf against the back wall (indoor border scenery). */
function buildBookshelf(seed: number): Sprite {
	const buffer = new PixelBuffer(18, 34);
	const wood = SWATCH.orange645;
	buffer.rect(1, 1, 16, 31, wood);
	buffer.hline(1, 1, 16, light(wood, 0.3));
	buffer.vline(16, 1, 31, shade(wood, 0.3));
	const books = [
		SWATCH.red430,
		SWATCH.blue420,
		SWATCH.amber445,
		SWATCH.green525Muted,
		SWATCH.purple440,
		SWATCH.amber145Muted,
	];
	for (let shelf = 0; shelf < 3; shelf++) {
		const y = 3 + shelf * 9;
		buffer.rect(3, y, 12, 7, shade(wood, 0.45));
		let x = 3;
		let i = 0;
		while (x < 15) {
			const bw = 1 + Math.floor(noise(i, shelf, seed) * 2);
			const bh = 4 + Math.floor(noise(i, shelf + 9, seed) * 3);
			const color =
				books[(i + shelf + seed) % books.length] ?? SWATCH.white10Muted;
			buffer.rect(x, y + 7 - bh, Math.min(bw, 15 - x), bh, color);
			buffer.set(x, y + 7 - bh, light(color, 0.3));
			x += bw;
			i++;
		}
		buffer.hline(2, y + 7, 14, light(wood, 0.15));
	}
	buffer.outline(0.5);
	return toSprite(buffer, 9, 33);
}

const shelfSprites = spriteCache(buildBookshelf);
export function bookshelfSprite(seed: number): Sprite {
	return shelfSprites(String(seed % 4), seed % 4);
}

// ---------------------------------------------------------------------------
// Office furniture (the indoor theme's walls and corners)
// ---------------------------------------------------------------------------

/** A grey filing cabinet with three drawers. */
function buildCabinet(): Sprite {
	const buffer = new PixelBuffer(16, 26);
	const metal = SWATCH.coolGrey390;
	buffer.rect(2, 4, 12, 20, metal);
	buffer.hline(2, 4, 12, light(metal, 0.35));
	buffer.vline(13, 4, 20, shade(metal, 0.3));
	for (let drawer = 0; drawer < 3; drawer++) {
		const y = 6 + drawer * 6;
		buffer.hline(3, y + 5, 10, shade(metal, 0.28));
		buffer.rect(6, y + 2, 4, 1, SWATCH.blue130);
		buffer.set(6, y + 3, shade(metal, 0.4));
		buffer.set(9, y + 3, shade(metal, 0.4));
	}
	buffer.rect(4, 1, 5, 3, SWATCH.yellow30);
	buffer.hline(5, 2, 3, SWATCH.warmGrey310);
	buffer.outline(0.5);
	return toSprite(buffer, 8, 25);
}

/** A coffee bar: a counter with an espresso machine and mugs. */
function buildCoffeeBar(): Sprite {
	const buffer = new PixelBuffer(18, 30);
	const wood = SWATCH.orange645;
	buffer.rect(1, 13, 16, 15, wood);
	buffer.hline(1, 13, 16, light(wood, 0.3));
	buffer.rect(1, 14, 16, 2, SWATCH.amber375);
	buffer.vline(16, 14, 14, shade(wood, 0.3));
	buffer.vline(8, 17, 10, shade(wood, 0.25));
	buffer.set(6, 21, SWATCH.amber410Muted);
	buffer.set(10, 21, SWATCH.amber410Muted);
	// Espresso machine.
	buffer.rect(3, 3, 9, 10, SWATCH.coolGrey185);
	buffer.hline(3, 3, 9, SWATCH.grey40);
	buffer.rect(4, 6, 7, 3, SWATCH.coolGrey735);
	buffer.set(5, 7, SWATCH.red435);
	buffer.rect(6, 10, 3, 2, SWATCH.coolGrey735);
	// Mugs.
	buffer.rect(13, 10, 3, 3, SWATCH.grey50);
	buffer.set(16, 11, SWATCH.grey185);
	buffer.rect(13, 7, 3, 3, SWATCH.red430);
	buffer.outline(0.5);
	return toSprite(buffer, 9, 29);
}

/** A two-seat couch seen from the front, with a cushion. */
function buildCouch(seed: number): Sprite {
	const buffer = new PixelBuffer(18, 22);
	const cloth =
		[SWATCH.blue455Muted, SWATCH.green545, SWATCH.orange470][seed % 3] ??
		SWATCH.blue455Muted;
	buffer.rect(2, 4, 14, 8, shade(cloth, 0.1));
	buffer.hline(2, 4, 14, light(cloth, 0.3));
	buffer.rect(1, 8, 3, 10, shade(cloth, 0.2));
	buffer.rect(14, 8, 3, 10, shade(cloth, 0.32));
	buffer.rect(3, 11, 12, 6, cloth);
	buffer.hline(3, 11, 12, light(cloth, 0.2));
	buffer.vline(9, 11, 6, shade(cloth, 0.22));
	buffer.rect(4, 6, 4, 4, SWATCH.yellow165);
	buffer.hline(4, 6, 4, SWATCH.yellow70);
	buffer.rect(2, 18, 2, 2, SWATCH.orange755);
	buffer.rect(14, 18, 2, 2, SWATCH.orange755);
	buffer.outline(0.5);
	return toSprite(buffer, 9, 21);
}

/** A brass floor lamp with a warm shade. */
function buildFloorLamp(): Sprite {
	const buffer = new PixelBuffer(14, 32);
	buffer.rect(3, 2, 8, 2, SWATCH.yellow190);
	buffer.rect(2, 4, 10, 5, SWATCH.amber285);
	buffer.hline(2, 4, 10, SWATCH.yellow110);
	buffer.hline(2, 8, 10, SWATCH.amber430);
	buffer.rect(6, 9, 2, 19, SWATCH.amber590);
	buffer.vline(6, 9, 19, SWATCH.amber410Muted);
	buffer.rect(3, 27, 8, 2, SWATCH.amber680);
	buffer.hline(3, 27, 8, SWATCH.amber495);
	buffer.outline(0.5);
	return toSprite(buffer, 7, 30);
}

const officeSprites = spriteCache(
	(kind: "cabinet" | "coffee" | "couch" | "lamp", seed: number) => {
		switch (kind) {
			case "cabinet":
				return buildCabinet();
			case "coffee":
				return buildCoffeeBar();
			case "couch":
				return buildCouch(seed);
			default:
				return buildFloorLamp();
		}
	}
);

export type OfficePiece = "cabinet" | "coffee" | "couch" | "lamp";

export function officeSprite(kind: OfficePiece, seed = 0): Sprite {
	return officeSprites(`${kind}|${seed % 3}`, kind, seed);
}
