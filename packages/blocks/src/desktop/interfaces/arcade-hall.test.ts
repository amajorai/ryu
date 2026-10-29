import { describe, expect, test } from "bun:test";
import { hallColumns, layoutHall } from "./arcade-diorama.tsx";
import { GLYPH_BITMAPS, glyphCells, glyphMesh } from "./arcade-glyphs.ts";
import type { Machine } from "./arcade-model.ts";

const machines = (count: number): Machine[] =>
	Array.from(
		{ length: count },
		(_, index) => ({ id: `m${index}` }) as unknown as Machine
	);

describe("layoutHall", () => {
	test("every screen faces the camera, whatever the count", () => {
		for (const count of [1, 3, 6, 9, 12]) {
			for (const cabinet of layoutHall(machines(count)).cabinets) {
				expect(cabinet.yaw).toBeCloseTo(Math.PI / 4);
			}
		}
	});

	test("more than six cabinets split into rows; portrait rows are narrow", () => {
		expect(hallColumns(1, false)).toBe(1);
		expect(hallColumns(6, false)).toBe(6);
		expect(hallColumns(12, false)).toBe(6);
		expect(hallColumns(9, false)).toBe(5);
		expect(hallColumns(6, true)).toBe(2);
	});

	test("cabinets never overlap, and all stand inside the hall", () => {
		for (const portrait of [false, true]) {
			const hall = layoutHall(machines(12), portrait);
			for (const [index, a] of hall.cabinets.entries()) {
				expect(Math.abs(a.x)).toBeLessThan(hall.halfWidth - 0.5);
				expect(Math.abs(a.z)).toBeLessThan(hall.halfDepth - 0.5);
				for (const b of hall.cabinets.slice(index + 1)) {
					expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5);
				}
			}
			for (const [x, z] of [hall.counter, hall.claw]) {
				expect(Math.abs(x)).toBeLessThan(hall.halfWidth);
				expect(Math.abs(z)).toBeLessThan(hall.halfDepth);
			}
		}
	});
});

describe("reel glyphs", () => {
	test("every bitmap is rectangular, and meshes are two triangles a cell", () => {
		for (const rows of Object.values(GLYPH_BITMAPS)) {
			expect(new Set(rows.map((row) => row.length)).size).toBe(1);
			const lit = glyphCells(rows, "#").length;
			expect(lit).toBeGreaterThan(0);
			expect(glyphMesh(rows, "#", 0.24).positions).toHaveLength(lit * 18);
		}
	});
});
