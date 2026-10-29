import type { ReelSymbol } from "./arcade-model.ts";

/**
 * The 3D cabinets' reel symbols as bold pixel art, so they read at the
 * hall's default zoom: cherries, a seven, a bell and a flame (a blank reel
 * stays empty; BAR is lettered in a real typeface, see `arcade-diorama`).
 * Each bitmap row is a string: `#` is the symbol's colour, `+` its detail
 * colour (stems, a bell's knob, a flame's core), `.` is empty.
 */
export type PixelSymbol = Exclude<ReelSymbol, "bar" | "blank">;

export const GLYPH_BITMAPS: Record<PixelSymbol, readonly string[]> = {
	bell: [
		"....+....",
		"...###...",
		"..#####..",
		"..#####..",
		".#######.",
		".#######.",
		"#########",
		"....+....",
	],
	cherry: [
		".....+++.",
		"....+..+.",
		"...+...+.",
		"..+....+.",
		".###..###",
		"####.####",
		"####.####",
		".##...##.",
	],
	flame: [
		"....#....",
		"...##....",
		"...###...",
		"..####.#.",
		".###+###.",
		".##+++##.",
		".##+++##.",
		"..#####..",
	],
	seven: [
		"#########",
		"#########",
		"......##.",
		".....##..",
		"....##...",
		"...##....",
		"...##....",
		"...##....",
	],
};

/** The lit cells of `mark` in a bitmap, as [column, row] from the top left. */
export function glyphCells(
	rows: readonly string[],
	mark: "#" | "+"
): [number, number][] {
	const cells: [number, number][] = [];
	for (const [row, line] of rows.entries()) {
		for (const [column, cell] of [...line].entries()) {
			if (cell === mark) {
				cells.push([column, row]);
			}
		}
	}
	return cells;
}

/** A glyph's flat mesh data: two triangles per lit cell, facing +z. */
export interface GlyphMeshData {
	normals: Float32Array;
	positions: Float32Array;
}

/**
 * The mesh data for every `mark` cell of a bitmap: a quad per cell, the
 * whole glyph `width` world units wide and centred on the origin.
 */
export function glyphMesh(
	rows: readonly string[],
	mark: "#" | "+",
	width: number
): GlyphMeshData {
	const columns = Math.max(...rows.map((line) => line.length));
	const cell = width / columns;
	const left = -width / 2;
	const top = (rows.length * cell) / 2;
	const cells = glyphCells(rows, mark);
	const positions = new Float32Array(cells.length * 18);
	const normals = new Float32Array(cells.length * 18);
	for (const [index, [column, row]] of cells.entries()) {
		const x0 = left + column * cell;
		const x1 = x0 + cell;
		const y1 = top - row * cell;
		const y0 = y1 - cell;
		positions.set(
			[x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0],
			index * 18
		);
		for (let vertex = 0; vertex < 6; vertex++) {
			normals.set([0, 0, 1], index * 18 + vertex * 3);
		}
	}
	return { normals, positions };
}
