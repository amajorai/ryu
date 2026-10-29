import { PIXEL_GLYPHS } from "./world-2d-font-glyphs.ts";

/**
 * The village HUD's pixel face, "Ryu Village Pixel": the 5x7 bitmap glyphs
 * in `world-2d-font-glyphs.ts`, packed into a small TrueType font in memory
 * and registered with the FontFace API (no network, no stylesheet, no
 * binary blob). It gives the HUD one type system with the pixel art and the
 * village sign instead of the app's sans.
 *
 * One em is 8 font pixels, so the face stays crisp at whole multiples of
 * 8px: 16px (2x) for HUD text and 8px (1x) for keycaps and slot numbers.
 * The app's display face covers any character the glyphs lack.
 */

export const PIXEL_FONT_FAMILY = "Ryu Village Pixel";

/** CSS `font-family` for the HUD: the pixel face, then the app's. */
export const PIXEL_FONT_STACK = `"${PIXEL_FONT_FAMILY}", var(--font-heading), sans-serif`;

/** Font units per glyph pixel (an em is 8 pixels). */
const UNIT = 125;
const UNITS_PER_EM = 1000;
/** Cap height in pixels: row 0 of a glyph sits this far above the baseline. */
const CAP_PIXELS = 7;
const ASCENT = 8 * UNIT;
const DESCENT = 2 * UNIT;
const X_HEIGHT = 5 * UNIT;

interface Rect {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

interface Glyph {
	advance: number;
	code: number;
	rects: Rect[];
}

/** One rectangle per horizontal run of pixels, in font units. */
function glyphRects(rows: readonly string[]): Rect[] {
	const rects: Rect[] = [];
	for (const [row, line] of rows.entries()) {
		let x = 0;
		while (x < line.length) {
			if (line[x] !== "#") {
				x++;
				continue;
			}
			let run = 1;
			while (line[x + run] === "#") {
				run++;
			}
			const top = (CAP_PIXELS - row) * UNIT;
			rects.push({
				bottom: top - UNIT,
				left: x * UNIT,
				right: (x + run) * UNIT,
				top,
			});
			x += run;
		}
	}
	return rects;
}

/** Big-endian byte writer. */
class Bytes {
	private readonly data: number[] = [];

	get length(): number {
		return this.data.length;
	}

	u8(value: number): this {
		this.data.push(value & 0xff);
		return this;
	}

	u16(value: number): this {
		return this.u8(value >> 8).u8(value);
	}

	u32(value: number): this {
		return this.u16(Math.floor(value / 0x1_00_00) & 0xff_ff).u16(
			value & 0xff_ff
		);
	}

	tag(name: string): this {
		for (const char of name) {
			this.u8(char.charCodeAt(0));
		}
		return this;
	}

	append(other: Bytes): this {
		for (const byte of other.bytes()) {
			this.data.push(byte);
		}
		return this;
	}

	padTo4(): this {
		while (this.data.length % 4 !== 0) {
			this.data.push(0);
		}
		return this;
	}

	bytes(): readonly number[] {
		return this.data;
	}
}

function checksum(bytes: readonly number[]): number {
	let sum = 0;
	for (let index = 0; index < bytes.length; index += 4) {
		const word =
			((bytes[index] ?? 0) * 0x1_00_00_00 +
				((bytes[index + 1] ?? 0) << 16) +
				((bytes[index + 2] ?? 0) << 8) +
				(bytes[index + 3] ?? 0)) >>>
			0;
		sum = (sum + word) % 0x1_00_00_00_00;
	}
	return sum;
}

/** Simple glyph outline: one clockwise square contour per pixel run. */
function glyfEntry(rects: readonly Rect[]): Bytes {
	const out = new Bytes();
	if (rects.length === 0) {
		return out;
	}
	let xMin = Number.POSITIVE_INFINITY;
	let yMin = Number.POSITIVE_INFINITY;
	let xMax = Number.NEGATIVE_INFINITY;
	let yMax = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		xMin = Math.min(xMin, rect.left);
		yMin = Math.min(yMin, rect.bottom);
		xMax = Math.max(xMax, rect.right);
		yMax = Math.max(yMax, rect.top);
	}
	out.u16(rects.length).u16(xMin).u16(yMin).u16(xMax).u16(yMax);
	for (const [index] of rects.entries()) {
		out.u16(index * 4 + 3);
	}
	out.u16(0); // no instructions
	const points: [number, number][] = [];
	for (const rect of rects) {
		points.push(
			[rect.left, rect.bottom],
			[rect.left, rect.top],
			[rect.right, rect.top],
			[rect.right, rect.bottom]
		);
	}
	for (const _point of points) {
		out.u8(1); // on-curve, 16-bit deltas
	}
	let previous = 0;
	for (const [x] of points) {
		out.u16(x - previous);
		previous = x;
	}
	previous = 0;
	for (const [, y] of points) {
		out.u16(y - previous);
		previous = y;
	}
	return out.padTo4();
}

/** cmap: one format 4 subtable (Windows, Unicode BMP). */
function cmapTable(glyphs: readonly Glyph[]): Bytes {
	const mapped = glyphs
		.map((glyph, id) => ({ code: glyph.code, id }))
		.filter((entry) => entry.code >= 0)
		.sort((a, b) => a.code - b.code);
	const segments = [...mapped, { code: 0xff_ff, id: 0 }];
	const segCount = segments.length;
	const entrySelector = Math.floor(Math.log2(segCount));
	const searchRange = 2 * 2 ** entrySelector;
	const sub = new Bytes();
	sub
		.u16(4)
		.u16(16 + segCount * 8)
		.u16(0)
		.u16(segCount * 2)
		.u16(searchRange)
		.u16(entrySelector)
		.u16(segCount * 2 - searchRange);
	for (const segment of segments) {
		sub.u16(segment.code);
	}
	sub.u16(0);
	for (const segment of segments) {
		sub.u16(segment.code);
	}
	for (const segment of segments) {
		sub.u16(segment.code === 0xff_ff ? 1 : segment.id - segment.code);
	}
	for (const _segment of segments) {
		sub.u16(0);
	}
	return new Bytes().u16(0).u16(1).u16(3).u16(1).u32(12).append(sub);
}

function nameTable(): Bytes {
	const names: [number, string][] = [
		[1, PIXEL_FONT_FAMILY],
		[2, "Regular"],
		[4, PIXEL_FONT_FAMILY],
		[6, PIXEL_FONT_FAMILY.replaceAll(" ", "")],
	];
	const header = new Bytes()
		.u16(0)
		.u16(names.length)
		.u16(6 + names.length * 12);
	const strings = new Bytes();
	for (const [id, text] of names) {
		header
			.u16(3)
			.u16(1)
			.u16(0x4_09)
			.u16(id)
			.u16(text.length * 2)
			.u16(strings.length);
		for (const char of text) {
			strings.u16(char.charCodeAt(0));
		}
	}
	return header.append(strings);
}

function os2Table(glyphs: readonly Glyph[], averageWidth: number): Bytes {
	const codes = glyphs.map((glyph) => glyph.code).filter((code) => code >= 0);
	const table = new Bytes().u16(4).u16(averageWidth).u16(400).u16(5).u16(0);
	// Sub- and superscript sizes and offsets, strikeout size and position.
	for (const value of [650, 700, 0, 140, 650, 700, 0, 480, UNIT, 3 * UNIT]) {
		table.u16(value);
	}
	table.u16(0);
	for (let index = 0; index < 10; index++) {
		table.u8(0);
	}
	table.u32(1).u32(0).u32(0).u32(0); // Basic Latin
	table
		.tag("RYU ")
		.u16(0x40)
		.u16(Math.min(...codes))
		.u16(Math.max(...codes))
		.u16(ASCENT)
		.u16(-DESCENT)
		.u16(0)
		.u16(ASCENT)
		.u16(DESCENT)
		.u32(1)
		.u32(0)
		.u16(X_HEIGHT)
		.u16(CAP_PIXELS * UNIT)
		.u16(0)
		.u16(32)
		.u16(1);
	return table;
}

/** Builds the TrueType file from the glyph table. */
export function buildPixelFont(): Uint8Array<ArrayBuffer> {
	const glyphs: Glyph[] = [
		{
			advance: 5 * UNIT,
			code: -1,
			rects: [{ bottom: 0, left: 0, right: 4 * UNIT, top: CAP_PIXELS * UNIT }],
		},
	];
	for (const [char, rows] of PIXEL_GLYPHS) {
		let width = 0;
		for (const row of rows) {
			width = Math.max(width, row.length);
		}
		glyphs.push({
			advance: (width + 1) * UNIT,
			code: char.codePointAt(0) ?? 0,
			rects: glyphRects(rows),
		});
	}

	const glyf = new Bytes();
	const loca = new Bytes();
	let maxPoints = 0;
	let maxContours = 0;
	let xMin = 0;
	let yMin = 0;
	let xMax = 0;
	let yMax = 0;
	for (const glyph of glyphs) {
		loca.u32(glyf.length);
		glyf.append(glyfEntry(glyph.rects));
		maxContours = Math.max(maxContours, glyph.rects.length);
		maxPoints = Math.max(maxPoints, glyph.rects.length * 4);
		for (const rect of glyph.rects) {
			xMin = Math.min(xMin, rect.left);
			yMin = Math.min(yMin, rect.bottom);
			xMax = Math.max(xMax, rect.right);
			yMax = Math.max(yMax, rect.top);
		}
	}
	loca.u32(glyf.length);

	const hmtx = new Bytes();
	let advanceMax = 0;
	let advanceSum = 0;
	for (const glyph of glyphs) {
		const lsb = glyph.rects.reduce(
			(least, rect) => Math.min(least, rect.left),
			glyph.rects.length > 0 ? Number.POSITIVE_INFINITY : 0
		);
		hmtx.u16(glyph.advance).u16(lsb);
		advanceMax = Math.max(advanceMax, glyph.advance);
		advanceSum += glyph.advance;
	}

	const head = new Bytes()
		.u32(0x1_00_00)
		.u32(0x1_00_00)
		.u32(0) // checkSumAdjustment, patched below
		.u32(0x5f_0f_3c_f5)
		.u16(0b1001)
		.u16(UNITS_PER_EM)
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0)
		.u16(xMin)
		.u16(yMin)
		.u16(xMax)
		.u16(yMax)
		.u16(0)
		.u16(8)
		.u16(2)
		.u16(1)
		.u16(0);
	const hhea = new Bytes()
		.u32(0x1_00_00)
		.u16(ASCENT)
		.u16(-DESCENT)
		.u16(0)
		.u16(advanceMax)
		.u16(0)
		.u16(0)
		.u16(xMax)
		.u16(1)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(glyphs.length);
	const maxp = new Bytes()
		.u32(0x1_00_00)
		.u16(glyphs.length)
		.u16(maxPoints)
		.u16(maxContours)
		.u16(0)
		.u16(0)
		.u16(2);
	for (let index = 0; index < 8; index++) {
		maxp.u16(0);
	}
	const post = new Bytes()
		.u32(0x3_00_00)
		.u32(0)
		.u16(-DESCENT)
		.u16(UNIT)
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0);

	const tables: [string, Bytes][] = [
		["OS/2", os2Table(glyphs, Math.round(advanceSum / glyphs.length))],
		["cmap", cmapTable(glyphs)],
		["glyf", glyf],
		["head", head],
		["hhea", hhea],
		["hmtx", hmtx],
		["loca", loca],
		["maxp", maxp],
		["name", nameTable()],
		["post", post],
	];
	const entrySelector = Math.floor(Math.log2(tables.length));
	const searchRange = 16 * 2 ** entrySelector;
	const file = new Bytes()
		.u32(0x1_00_00)
		.u16(tables.length)
		.u16(searchRange)
		.u16(entrySelector)
		.u16(tables.length * 16 - searchRange);
	let offset = 12 + tables.length * 16;
	let headOffset = 0;
	for (const [tag, table] of tables) {
		if (tag === "head") {
			headOffset = offset;
		}
		file.tag(tag).u32(checksum(table.bytes())).u32(offset).u32(table.length);
		offset += Math.ceil(table.length / 4) * 4;
	}
	for (const [, table] of tables) {
		file.append(table.padTo4());
	}
	const bytes = Uint8Array.from(file.bytes());
	const adjustment =
		(0xb1_b0_af_ba - checksum(file.bytes()) + 0x1_00_00_00_00) %
		0x1_00_00_00_00;
	new DataView(bytes.buffer).setUint32(headOffset + 8, adjustment);
	return bytes;
}

let loading: Promise<void> | null = null;

/**
 * Registers the pixel face with the document once. A no-op where the
 * FontFace API is missing (server rendering, tests); on failure the app's
 * display face stands in and a later mount tries again.
 */
export function loadPixelFont(): Promise<void> {
	if (loading) {
		return loading;
	}
	if (typeof document === "undefined" || typeof FontFace === "undefined") {
		return Promise.resolve();
	}
	const face = new FontFace(PIXEL_FONT_FAMILY, buildPixelFont(), {
		display: "block",
		style: "normal",
		weight: "400",
	});
	loading = face
		.load()
		.then((loaded) => {
			document.fonts.add(loaded);
		})
		.catch(() => {
			loading = null;
		});
	return loading;
}
