import { describe, expect, test } from "bun:test";
import {
	type InterfaceSnapshot,
	layoutWorld,
} from "@ryuhq/protocol/interfaces";
import {
	chooseFocusSide,
	conversationSpot,
	FOCUS_DISTANCE,
	focusEye,
	houseBoxes,
	lineBlocked,
	occludingHouses,
	pairCenter,
	shotBlockers,
	type TreeObstacle,
	treeHits,
} from "./world-3d-focus.ts";
import { spreadVillage } from "./world-3d-spread.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import { layoutVillage } from "./world-village.ts";

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

function village(count: number) {
	const layout = layoutWorld(snapshotWith(count));
	return spreadVillage(layout, layoutVillage(layout));
}

describe("conversation framing", () => {
	test.each([
		6, 12, 30, 64,
	])("every agent in a %i-agent village is filmed from the street", (count) => {
		const spread = village(count);
		const boxes = houseBoxes(spread.layout, spread.village.houses);
		for (const entity of spread.layout.entities) {
			// The player steps beside the agent to talk.
			const agent = tileToWorld(spread.layout, entity);
			const player = conversationSpot(agent);
			expect(lineBlocked(agent, player, boxes)).toBe(false);
			const side = chooseFocusSide(agent, player, boxes);
			const center = pairCenter(agent, player);
			const eye = focusEye(center, side, FOCUS_DISTANCE);
			// In front of the pair, never over the agent's own roof.
			expect(eye[2]).toBeGreaterThan(center[2] + FOCUS_DISTANCE * 0.7);
			const hidden = occludingHouses(agent, player, eye, boxes);
			expect(hidden.has(entity.agentId)).toBe(false);
			// A clear side is preferred; otherwise what blocks it is see-through.
			if (lineBlocked(center, eye, boxes)) {
				expect(hidden.size).toBeGreaterThan(0);
			}
		}
	});

	test("the shot looks over the player's shoulder when nothing is in the way", () => {
		const agent: [number, number, number] = [0, 0, 0];
		expect(chooseFocusSide(agent, conversationSpot(agent), [])).toBe(1);
	});

	test("a shot through a cottage is detected and that cottage is listed", () => {
		const spread = village(6);
		const boxes = houseBoxes(spread.layout, spread.village.houses);
		const [first] = spread.village.houses;
		const box = boxes.find((item) => item.agentId === first?.agentId);
		expect(box).toBeDefined();
		if (!box) {
			return;
		}
		const middleX = (box.minX + box.maxX) / 2;
		// From behind the cottage, low, toward a point in front of it.
		const behind: [number, number, number] = [middleX, 1, box.minZ - 2];
		const front: [number, number, number] = [middleX, 0.85, box.maxZ + 1];
		expect(lineBlocked(front, behind, boxes)).toBe(true);
		expect(occludingHouses(front, front, behind, boxes).has(box.agentId)).toBe(
			true
		);
	});
});

describe("conversation framing around trees", () => {
	test("a tree beside the lens on the player's side swings the shot", () => {
		const agent: [number, number, number] = [0, 0, 0];
		const player = conversationSpot(agent);
		const eye = focusEye(pairCenter(agent, player), 1, FOCUS_DISTANCE + 1.2);
		const tree: TreeObstacle = {
			radius: 0.55,
			top: 1.6,
			x: eye[0] + 0.5,
			z: eye[2] - 1.0,
		};
		expect(shotBlockers(agent, player, 1, [], [tree])).toBeGreaterThan(0);
		expect(chooseFocusSide(agent, player, [], [tree])).not.toBe(1);
	});

	test("a tree crown on the line of sight is detected", () => {
		const tree: TreeObstacle = { radius: 0.5, top: 1.5, x: 0, z: 2 };
		expect(treeHits(tree, [0, 0.8, 0], [0, 1.2, 5])).toBe(true);
		expect(treeHits(tree, [3, 0.8, 0], [3, 1.2, 5])).toBe(false);
	});
});
