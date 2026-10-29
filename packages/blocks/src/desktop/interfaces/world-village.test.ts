import { describe, expect, test } from "bun:test";
import {
	type InterfaceSnapshot,
	isWorldTileFree,
	layoutWorld,
	type WorldLayout,
} from "@ryuhq/protocol/interfaces";
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

function reachable(
	layout: WorldLayout,
	blocked: ReadonlySet<string>
): Set<string> {
	const seen = new Set([tileKey(layout.spawn.x, layout.spawn.y)]);
	const queue = [layout.spawn];
	while (queue.length > 0) {
		const point = queue.shift();
		if (!point) {
			break;
		}
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		] as const) {
			const next = { x: point.x + dx, y: point.y + dy };
			const key = tileKey(next.x, next.y);
			if (
				!seen.has(key) &&
				isWorldTileFree(layout, next) &&
				!blocked.has(key)
			) {
				seen.add(key);
				queue.push(next);
			}
		}
	}
	return seen;
}

describe("layoutVillage", () => {
	for (const count of [0, 1, 2, 5, 6, 9, 17, 40]) {
		test(`${count} agents: every doorstep is reachable and nothing overlaps`, () => {
			const layout = layoutWorld(snapshotWith(count));
			const village = layoutVillage(layout);
			expect(village.houses).toHaveLength(layout.entities.length);
			const seen = reachable(layout, village.blocked);
			for (const entity of layout.entities) {
				expect(seen.has(tileKey(entity.x, entity.y + 1))).toBe(true);
				expect(village.blocked.has(tileKey(entity.x, entity.y))).toBe(false);
			}
			for (const key of village.paths) {
				expect(village.blocked.has(key)).toBe(false);
			}
			expect(village.blocked.has(tileKey(layout.spawn.x, layout.spawn.y))).toBe(
				false
			);
		});
	}

	test("is deterministic", () => {
		const layout = layoutWorld(snapshotWith(6));
		const a = layoutVillage(layout);
		const b = layoutVillage(layout);
		expect(a.trees).toEqual(b.trees);
		expect([...a.paths]).toEqual([...b.paths]);
	});
});
