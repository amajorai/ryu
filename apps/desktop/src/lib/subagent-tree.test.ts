import { describe, expect, test } from "bun:test";
import type {
	SessionSummary,
	ThreadTreeNode,
} from "@/src/lib/api/hierarchy.ts";
import {
	buildSubagentTree,
	flattenSubagentTree,
	type SubagentTreeNode,
	type SubagentTreeRow,
	treeFromSessions,
} from "./subagent-tree.ts";

function summary(
	id: string,
	extra: Partial<SessionSummary> = {}
): SessionSummary {
	return {
		agent_id: null,
		id,
		message_count: 0,
		run_status: null,
		title: `Title ${id}`,
		updated_at: 1,
		...extra,
	};
}

function wire(
	id: string,
	parent: string | null,
	extra: Partial<SessionSummary> = {}
): ThreadTreeNode {
	return { conversation: summary(id, extra), parent_id: parent };
}

/** `id(child child)` for every node, so a whole shape reads in one line. */
function shape(nodes: readonly SubagentTreeNode[]): string {
	return nodes
		.map((node) =>
			node.children.length > 0 ? `${node.id}(${shape(node.children)})` : node.id
		)
		.join(" ");
}

const NEST = [
	wire("root", null, { thread_role: "main", agent_id: "scout" }),
	wire("a", "root", { run_status: "running" }),
	wire("b", "root", { run_status: "failed" }),
	wire("a1", "a"),
	wire("a2", "a", { agent_id: "writer" }),
	wire("a1x", "a1"),
];

describe("buildSubagentTree", () => {
	test("nests a three-level tree and keeps Core's order among siblings", () => {
		const roots = buildSubagentTree(NEST);
		expect(shape(roots)).toBe("root(a(a1(a1x) a2) b)");
	});

	test("the order of the rows does not matter", () => {
		const roots = buildSubagentTree([...NEST].reverse());
		expect(shape(roots)).toBe("root(b a(a2 a1(a1x)))");
	});

	test("carries the fields a row shows", () => {
		const names: Record<string, string> = { scout: "Scout" };
		const [root] = buildSubagentTree(NEST, (id) => names[id]);
		expect(root).toMatchObject({
			agentId: "scout",
			agentName: "Scout",
			conversationId: "root",
			id: "root",
			kind: "thread",
			parentId: null,
			status: null,
			title: "Title root",
			updatedAt: 1,
		});
		const [a, b] = root.children;
		expect(a).toMatchObject({ kind: "session", parentId: "root" });
		expect(a.status).toBe("running");
		expect(b.status).toBe("failed");
		// An agent the resolver does not know has no name, and a row without an
		// agent never asks.
		expect(a.children[1]).toMatchObject({ agentId: "writer" });
		expect(a.children[1].agentName).toBeUndefined();
		expect(a.agentName).toBeUndefined();
	});

	test("a main thread spawned by another one is still a thread", () => {
		const [root] = buildSubagentTree([
			wire("project", null, { thread_role: "main" }),
			wire("bot", "project", { thread_role: "main" }),
			wire("work", "bot", { thread_role: "session" }),
		]);
		expect(root.children[0].kind).toBe("thread");
		expect(root.children[0].children[0].kind).toBe("session");
	});

	test("rows without a visible parent are roots of their own", () => {
		const roots = buildSubagentTree([
			wire("mine", null),
			{ conversation: summary("also-mine") },
			wire("orphan", "not-sent"),
			wire("below", "orphan"),
		]);
		expect(shape(roots)).toBe("mine also-mine orphan(below)");
		expect(roots.every((root) => root.parentId === null)).toBe(true);
	});

	test("a repeated id is kept once", () => {
		const roots = buildSubagentTree([
			wire("root", null),
			wire("a", "root"),
			wire("a", "root", { title: "Second copy" }),
			wire("root", "a"),
		]);
		expect(shape(roots)).toBe("root(a)");
		expect(roots[0].children[0].title).toBe("Title a");
	});

	test("a loop is cut instead of followed", () => {
		expect(shape(buildSubagentTree([wire("self", "self")]))).toBe("self");
		const pair = buildSubagentTree([wire("a", "b"), wire("b", "a")]);
		expect(shape(pair)).toBe("a(b)");
		const ring = buildSubagentTree([
			wire("a", "c"),
			wire("b", "a"),
			wire("c", "b"),
			wire("leaf", "c"),
		]);
		expect(shape(ring)).toBe("a(b(c(leaf)))");
		expect(flattenSubagentTree(ring)).toHaveLength(4);
	});

	test("an empty answer is an empty tree", () => {
		expect(buildSubagentTree([])).toEqual([]);
		expect(flattenSubagentTree([])).toEqual([]);
	});
});

describe("flattenSubagentTree", () => {
	const roots = buildSubagentTree(NEST);
	const mark = (row: SubagentTreeRow) => {
		if (!row.hasChildren) {
			return "";
		}
		return row.expanded ? " -" : " +";
	};
	const lines = (collapsed?: ReadonlySet<string>) =>
		flattenSubagentTree(roots, collapsed).map(
			(row) => `${"  ".repeat(row.depth)}${row.node.id}${mark(row)}`
		);

	test("lists every row top down with its depth", () => {
		expect(lines()).toEqual([
			"root -",
			"  a -",
			"    a1 -",
			"      a1x",
			"    a2",
			"  b",
		]);
	});

	test("a collapsed node keeps its row and hides everything below it", () => {
		expect(lines(new Set(["a"]))).toEqual(["root -", "  a +", "  b"]);
		expect(lines(new Set(["a1", "b"]))).toEqual([
			"root -",
			"  a -",
			"    a1 +",
			"    a2",
			"  b",
		]);
		expect(lines(new Set(["root"]))).toEqual(["root +"]);
	});

	test("collapsing an id that is not in the tree changes nothing", () => {
		expect(lines(new Set(["nope"]))).toEqual(lines());
	});

	test("several roots are listed one after the other", () => {
		const two = buildSubagentTree([
			wire("one", null),
			wire("two", null),
			wire("two-a", "two"),
		]);
		expect(
			flattenSubagentTree(two).map((row) => [row.node.id, row.depth])
		).toEqual([
			["one", 0],
			["two", 0],
			["two-a", 1],
		]);
	});
});

describe("treeFromSessions", () => {
	test("puts the sessions one level under the thread", () => {
		const nodes = treeFromSessions(summary("main"), [
			summary("s1"),
			summary("s2"),
		]);
		expect(shape(buildSubagentTree(nodes))).toBe("main(s1 s2)");
	});

	test("a thread listed among its own sessions is not repeated", () => {
		const nodes = treeFromSessions(summary("main"), [
			summary("main"),
			summary("s1"),
		]);
		expect(nodes.map((node) => node.conversation.id)).toEqual(["main", "s1"]);
	});
});
