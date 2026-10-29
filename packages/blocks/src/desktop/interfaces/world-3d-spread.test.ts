import { describe, expect, test } from "bun:test";
import {
	type InterfaceSnapshot,
	layoutWorld,
} from "@ryuhq/protocol/interfaces";
import { ROW_GAP, spreadVillage } from "./world-3d-spread.ts";
import { layoutVillage, tileKey } from "./world-village.ts";

function snapshotWith(count: number): InterfaceSnapshot {
	return {
		agents: Array.from({ length: count }, (_, index) => ({
			avatarUrl: null,
			description: "",
			id: `agent-${index}`,
			name: `Agent ${String(index).padStart(2, "0")}`,
			status: "idle" as const,
		})),
		groups: [],
		threads: [],
		version: 1,
	};
}

function spreadFor(count: number) {
	const layout = layoutWorld(snapshotWith(count));
	const village = layoutVillage(layout);
	return { layout, spread: spreadVillage(layout, village), village };
}

describe("spreadVillage", () => {
	test("a single row is drawn as laid out", () => {
		const { layout, spread, village } = spreadFor(2);
		expect(spread.layout).toBe(layout);
		expect(spread.village).toBe(village);
	});

	test("every doorstep faces open street, with no house in the camera's way", () => {
		for (const count of [6, 16, 64]) {
			const { spread } = spreadFor(count);
			const houseTiles = new Set<string>();
			for (const house of spread.village.houses) {
				for (let dy = 0; dy < house.h; dy++) {
					for (let dx = 0; dx < house.w; dx++) {
						houseTiles.add(tileKey(house.x + dx, house.y + dy));
					}
				}
			}
			for (const entity of spread.layout.entities) {
				// The tile in front of the agent and the lawn behind it stay open.
				for (let dy = 1; dy <= ROW_GAP + 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						expect(houseTiles.has(tileKey(entity.x + dx, entity.y + dy))).toBe(
							false
						);
					}
				}
			}
		}
	});

	test("keeps every house, agent, and path, and the road reaches the plaza", () => {
		const { layout, spread, village } = spreadFor(16);
		expect(spread.village.houses).toHaveLength(village.houses.length);
		expect(spread.layout.entities).toHaveLength(layout.entities.length);
		expect(spread.village.paths.size).toBeGreaterThanOrEqual(
			village.paths.size
		);
		for (const house of spread.village.houses) {
			expect(house.door.y).toBe(house.y + house.h - 1);
		}
		// The road leaves the top street toward the plaza and still gets there.
		const street = Math.min(...layout.entities.map((entity) => entity.y)) + 1;
		const roadX = Array.from({ length: layout.width }, (_, x) => x).find((x) =>
			village.paths.has(tileKey(x, street + 1))
		);
		expect(roadX).toBeDefined();
		const from = spread.mapPoint({ x: 0, y: street }).y;
		for (let y = from; y <= spread.village.plaza.top; y++) {
			expect(spread.village.paths.has(tileKey(roadX ?? 0, y))).toBe(true);
		}
	});

	test("maps the player onto the drawn grid like everything else", () => {
		const { layout, spread } = spreadFor(9);
		const [first] = layout.entities;
		const [drawn] = spread.layout.entities;
		expect(first && spread.mapPoint({ x: first.x, y: first.y })).toEqual(
			drawn && { x: drawn.x, y: drawn.y }
		);
		expect(spread.mapPoint(layout.spawn)).toEqual(spread.layout.spawn);
	});
});
