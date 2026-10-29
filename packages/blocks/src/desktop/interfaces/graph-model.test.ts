import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode } from "@ryuhq/protocol/interfaces";
import { settleGroups, stepToward } from "./graph-model.ts";

function node(
	overrides: Partial<GraphNode> & Pick<GraphNode, "id">
): GraphNode {
	return {
		kind: "agent",
		label: overrides.id,
		refId: overrides.id,
		status: "idle",
		threadCount: 0,
		x: 0,
		y: 0,
		...overrides,
	};
}

function member(group: string, agent: string): GraphEdge {
	return {
		id: `member:${group}:${agent}`,
		kind: "member",
		source: group,
		target: agent,
		weight: 1,
	};
}

describe("stepToward", () => {
	test("stops a line at a round node's edge", () => {
		expect(stepToward({ x: 0, y: 0 }, { x: 0, y: -220 }, 42)).toEqual({
			x: 0,
			y: -42,
		});
		const end = stepToward({ x: 190, y: -110 }, { x: 0, y: 0 }, 26);
		expect(Math.hypot(end.x - 190, end.y + 110)).toBeCloseTo(26, 5);
	});

	test("stays put when the nodes overlap", () => {
		expect(stepToward({ x: 4, y: 4 }, { x: 6, y: 4 }, 26)).toEqual({
			x: 4,
			y: 4,
		});
	});
});

describe("settleGroups", () => {
	const agents = [
		node({ id: "agent:a", x: 0, y: -220 }),
		node({ id: "agent:b", x: -190, y: -110 }),
		node({ id: "agent:c", x: -190, y: 110 }),
		node({ id: "agent:d", x: 190, y: 110 }),
	];

	test("puts a group just outside the ring at its members' center", () => {
		const graph = settleGroups({
			edges: [member("team:t", "agent:b"), member("team:t", "agent:c")],
			nodes: [
				node({ id: "you", kind: "you", refId: null }),
				...agents,
				node({ id: "team:t", kind: "team", x: 500, y: 500 }),
			],
		});
		const team = graph.nodes.find((entry) => entry.id === "team:t");
		expect(team?.x).toBe(-396);
		expect(team?.y).toBe(0);
	});

	test("spreads groups that would overlap", () => {
		const graph = settleGroups({
			edges: [member("team:t", "agent:b"), member("project:p", "agent:b")],
			nodes: [
				...agents,
				node({ id: "team:t", kind: "team" }),
				node({ id: "project:p", kind: "project" }),
			],
		});
		const [team, project] = ["team:t", "project:p"].map((id) =>
			graph.nodes.find((entry) => entry.id === id)
		);
		const distance = Math.hypot(
			(team?.x ?? 0) - (project?.x ?? 0),
			(team?.y ?? 0) - (project?.y ?? 0)
		);
		expect(distance).toBeGreaterThan(200);
	});
});
