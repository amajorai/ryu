/**
 * Pixel-art primitives for the 2D village. Every sprite is authored at its
 * native resolution (16x16 art tiles, 16x32 characters) into a
 * `PixelBuffer`, converted once into an offscreen canvas, and upscaled with
 * nearest-neighbor filtering, so every edge stays on the pixel grid.
 *
 * One world tile (a step of the player) spans 2x2 art tiles, the way a
 * Pelican Town lot does: a villager is one world tile tall, and a cottage's
 * 3x2-tile footprint is a 96x64 pixel facade, a little over twice a
 * villager's height with its roof.
 */

/** Art pixels per art tile. */
export const ART = 16;
/** Art pixels per world tile. */
export const PX = ART * 2;
/** Screen pixels per art pixel (integer zoom). */
export const SCALE = 3;
/** Screen pixels per world tile. */
export const TILE = PX * SCALE;
/** A character sprite's size in art pixels. */
export const CHARACTER = { h: 32, w: 16 } as const;

export type Rgba = readonly [number, number, number, number];

const colorCache = new Map<string, Rgba>();

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (cached). */
export function parseHex(hex: string): Rgba {
	const cached = colorCache.get(hex);
	if (cached) {
		return cached;
	}
	let value = hex.replace("#", "");
	if (value.length === 3) {
		value = [...value].map((char) => char + char).join("");
	}
	const parsed: Rgba = [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
		value.length >= 8 ? Number.parseInt(value.slice(6, 8), 16) : 255,
	];
	colorCache.set(hex, parsed);
	return parsed;
}

function toHex([r, g, b]: readonly number[]): string {
	return `#${[r, g, b]
		.map((channel) =>
			Math.round(Math.min(255, Math.max(0, channel ?? 0)))
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

interface Hsl {
	h: number;
	l: number;
	s: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, l, s: 0 };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) {
		h = (gn - bn) / d + (gn < bn ? 6 : 0);
	} else if (max === gn) {
		h = (bn - rn) / d + 2;
	} else {
		h = (rn - gn) / d + 4;
	}
	return { h: h * 60, l, s };
}

function hslToHex({ h, l, s }: Hsl): string {
	const hue = ((h % 360) + 360) % 360;
	const sat = Math.min(1, Math.max(0, s));
	const light = Math.min(1, Math.max(0, l));
	const c = (1 - Math.abs(2 * light - 1)) * sat;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = light - c / 2;
	const sector = Math.floor(hue / 60);
	const table: [number, number, number][] = [
		[c, x, 0],
		[x, c, 0],
		[0, c, x],
		[0, x, c],
		[x, 0, c],
		[c, 0, x],
	];
	const [r, g, b] = table[sector] ?? [c, x, 0];
	return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** Moves hue `h` toward `target` by at most `amount` degrees. */
function hueToward(h: number, target: number, amount: number): number {
	let delta = ((target - h + 540) % 360) - 180;
	if (Math.abs(delta) > amount) {
		delta = Math.sign(delta) * amount;
	}
	return h + delta;
}

/**
 * A darker shade whose hue drifts toward blue-purple, the way pixel artists
 * shade (never plain black). `amount` is 0..1.
 */
export function shade(hex: string, amount = 0.25): string {
	const [r, g, b] = parseHex(hex);
	const hsl = rgbToHsl(r, g, b);
	return hslToHex({
		h: hsl.s < 0.06 ? hsl.h : hueToward(hsl.h, 255, 40 * amount),
		l: hsl.l * (1 - amount),
		s: Math.min(1, hsl.s + 0.12 * amount),
	});
}

/** A lighter tint whose hue drifts toward warm yellow. `amount` is 0..1. */
export function light(hex: string, amount = 0.2): string {
	const [r, g, b] = parseHex(hex);
	const hsl = rgbToHsl(r, g, b);
	return hslToHex({
		h: hsl.s < 0.06 ? hsl.h : hueToward(hsl.h, 55, 30 * amount),
		l: hsl.l + (1 - hsl.l) * amount,
		s: hsl.s,
	});
}

/** Linear mix of two colors. */
export function mix(a: string, b: string, t: number): string {
	const ca = parseHex(a);
	const cb = parseHex(b);
	return toHex([0, 1, 2].map((i) => (ca[i] ?? 0) * (1 - t) + (cb[i] ?? 0) * t));
}

/** An HSL color from hue/sat/light percentages, as hex. */
export function hslPercentToHex(h: number, s: number, l: number): string {
	return hslToHex({ h, l: l / 100, s: s / 100 });
}

/** Deterministic 0..1 noise for an integer pair (and a seed). */
export function noise(x: number, y: number, seed = 0): number {
	let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_147_483_647) | 0;
	h = (h ^ (h >>> 13)) * 1_274_126_177;
	h ^= h >>> 16;
	return (h >>> 0) / 4_294_967_296;
}

/**
 * RGBA pixel grid with drawing helpers. Colors are hex strings; alpha in a
 * color (`#rrggbbaa`) blends over what is already there.
 */
export class PixelBuffer {
	readonly data: Uint8ClampedArray;
	readonly height: number;
	readonly width: number;

	constructor(width: number, height: number) {
		this.width = Math.max(1, Math.ceil(width));
		this.height = Math.max(1, Math.ceil(height));
		this.data = new Uint8ClampedArray(this.width * this.height * 4);
	}

	inside(x: number, y: number): boolean {
		return x >= 0 && y >= 0 && x < this.width && y < this.height;
	}

	alpha(x: number, y: number): number {
		return this.inside(x, y)
			? (this.data[(y * this.width + x) * 4 + 3] ?? 0)
			: 0;
	}

	/** The color at a pixel as `#rrggbb` (ignores alpha). */
	get(x: number, y: number): string {
		const i = (y * this.width + x) * 4;
		return toHex([
			this.data[i] ?? 0,
			this.data[i + 1] ?? 0,
			this.data[i + 2] ?? 0,
		]);
	}

	set(x: number, y: number, color: string): void {
		const px = Math.floor(x);
		const py = Math.floor(y);
		if (!this.inside(px, py)) {
			return;
		}
		const [r, g, b, a] = parseHex(color);
		const i = (py * this.width + px) * 4;
		if (a >= 255) {
			this.data[i] = r;
			this.data[i + 1] = g;
			this.data[i + 2] = b;
			this.data[i + 3] = 255;
			return;
		}
		const t = a / 255;
		const under = (this.data[i + 3] ?? 0) / 255;
		const out = t + under * (1 - t);
		if (out <= 0) {
			return;
		}
		for (let c = 0; c < 3; c++) {
			const base = this.data[i + c] ?? 0;
			const top = [r, g, b][c] ?? 0;
			this.data[i + c] = (top * t + base * under * (1 - t)) / out;
		}
		this.data[i + 3] = out * 255;
	}

	/** Clears a pixel to transparent. */
	clear(x: number, y: number): void {
		if (this.inside(x, y)) {
			this.data[(y * this.width + x) * 4 + 3] = 0;
		}
	}

	rect(x: number, y: number, w: number, h: number, color: string): void {
		for (let py = y; py < y + h; py++) {
			for (let px = x; px < x + w; px++) {
				this.set(px, py, color);
			}
		}
	}

	hline(x: number, y: number, w: number, color: string): void {
		this.rect(x, y, w, 1, color);
	}

	vline(x: number, y: number, h: number, color: string): void {
		this.rect(x, y, 1, h, color);
	}

	/** Filled pixel ellipse centered at (cx, cy). */
	ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void {
		for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
			for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
				const dx = (px + 0.5 - cx) / rx;
				const dy = (py + 0.5 - cy) / ry;
				if (dx * dx + dy * dy <= 1) {
					this.set(px, py, color);
				}
			}
		}
	}

	/**
	 * Paints a palette-indexed pixel map: each string is one row and each
	 * character a palette key; `.` and spaces are transparent.
	 */
	map(
		rows: readonly string[],
		palette: Readonly<Record<string, string>>,
		x = 0,
		y = 0,
		flip = false
	): void {
		rows.forEach((row, dy) => {
			for (let dx = 0; dx < row.length; dx++) {
				const key = row[flip ? row.length - 1 - dx : dx] ?? ".";
				const color = palette[key];
				if (color) {
					this.set(x + dx, y + dy, color);
				}
			}
		});
	}

	/**
	 * Selective outline: every transparent pixel touching an opaque one takes
	 * a deep, hue-shifted shade of that neighbor, so wood gets a dark brown
	 * line and leaves a dark green one, never black. `fixed` overrides the
	 * shade with one color (a canopy's olive line, say).
	 */
	outline(amount = 0.55, diagonal = false, fixed?: string): void {
		const marks: [number, number, string][] = [];
		const offsets = diagonal
			? [
					[0, -1],
					[1, 0],
					[0, 1],
					[-1, 0],
					[1, 1],
					[-1, 1],
					[1, -1],
					[-1, -1],
				]
			: [
					[0, -1],
					[1, 0],
					[0, 1],
					[-1, 0],
				];
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				if (this.alpha(x, y) > 0) {
					continue;
				}
				for (const [dx = 0, dy = 0] of offsets) {
					if (this.alpha(x + dx, y + dy) > 200) {
						marks.push([
							x,
							y,
							fixed ?? shade(this.get(x + dx, y + dy), amount),
						]);
						break;
					}
				}
			}
		}
		for (const [x, y, color] of marks) {
			this.set(x, y, color);
		}
	}

	/** Copies opaque pixels of another buffer onto this one. */
	blit(source: PixelBuffer, x: number, y: number, flip = false): void {
		for (let sy = 0; sy < source.height; sy++) {
			for (let sx = 0; sx < source.width; sx++) {
				const fx = flip ? source.width - 1 - sx : sx;
				const i = (sy * source.width + fx) * 4;
				const a = source.data[i + 3] ?? 0;
				if (a === 0) {
					continue;
				}
				const alphaHex =
					a >= 255 ? "" : Math.round(a).toString(16).padStart(2, "0");
				this.set(
					x + sx,
					y + sy,
					`${toHex([source.data[i] ?? 0, source.data[i + 1] ?? 0, source.data[i + 2] ?? 0])}${alphaHex}`
				);
			}
		}
	}

	toCanvas(): HTMLCanvasElement {
		const canvas = document.createElement("canvas");
		canvas.width = this.width;
		canvas.height = this.height;
		const context = canvas.getContext("2d");
		if (context) {
			const image = context.createImageData(this.width, this.height);
			image.data.set(this.data);
			context.putImageData(image, 0, 0);
		}
		return canvas;
	}
}

/** A drawn sprite: its canvas and the anchor point (feet/base) inside it. */
export interface Sprite {
	ax: number;
	ay: number;
	canvas: HTMLCanvasElement;
	/**
	 * Emissive pixels (lit window glass, a lantern), same size as `canvas`:
	 * added back over the night lightmap so lit glass glows in the dark.
	 */
	glow?: HTMLCanvasElement;
}

export function toSprite(
	buffer: PixelBuffer,
	ax: number,
	ay: number,
	glow?: PixelBuffer
): Sprite {
	return glow
		? { ax, ay, canvas: buffer.toCanvas(), glow: glow.toCanvas() }
		: { ax, ay, canvas: buffer.toCanvas() };
}

/** Memoizes sprite builders by key for the page's lifetime. */
export function spriteCache<Args extends unknown[]>(
	build: (...args: Args) => Sprite
): (key: string, ...args: Args) => Sprite {
	const cache = new Map<string, Sprite>();
	return (key, ...args) => {
		const hit = cache.get(key);
		if (hit) {
			return hit;
		}
		const sprite = build(...args);
		cache.set(key, sprite);
		return sprite;
	};
}

/** Draws a sprite with its anchor at (x, y) on a context, pixel aligned. */
export function drawSprite(
	context: CanvasRenderingContext2D,
	sprite: Sprite,
	x: number,
	y: number
): void {
	context.drawImage(
		sprite.canvas,
		Math.round(x - sprite.ax),
		Math.round(y - sprite.ay)
	);
}

// ---------------------------------------------------------------------------
// A 3x5 pixel font for signs drawn into the world
// ---------------------------------------------------------------------------

const GLYPHS: Readonly<Record<string, string>> = {
	" ": "000000000000000",
	A: "010101111101101",
	B: "110101110101110",
	C: "011100100100011",
	D: "110101101101110",
	E: "111100110100111",
	F: "111100110100100",
	G: "011100101101011",
	H: "101101111101101",
	I: "111010010010111",
	J: "001001001101010",
	K: "101101110101101",
	L: "100100100100111",
	M: "101111111101101",
	N: "110101101101101",
	O: "010101101101010",
	P: "110101110100100",
	Q: "010101101110011",
	R: "110101110101101",
	S: "011100010001110",
	T: "111010010010010",
	U: "101101101101111",
	V: "101101101101010",
	W: "101101111111101",
	X: "101101010101101",
	Y: "101101010010010",
	Z: "111001010100111",
};

/** Width in pixels of `text` in the 3x5 font (1px letter spacing). */
export function pixelTextWidth(text: string): number {
	return Math.max(0, text.length * 4 - 1);
}

/** Draws uppercase `text` in the 3x5 font with its top-left at (x, y). */
export function pixelText(
	buffer: PixelBuffer,
	text: string,
	x: number,
	y: number,
	color: string
): void {
	let cursor = x;
	for (const char of text.toUpperCase()) {
		const glyph = GLYPHS[char] ?? GLYPHS[" "] ?? "";
		for (let i = 0; i < 15; i++) {
			if (glyph[i] === "1") {
				buffer.set(cursor + (i % 3), y + Math.floor(i / 3), color);
			}
		}
		cursor += 4;
	}
}
