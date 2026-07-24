import { describe, expect, it } from "bun:test";
import {
	appendLeaves,
	containsLeaf,
	directionBefore,
	directionOrientation,
	insertLeaf,
	leafOrder,
	makeBranch,
	makeLeaf,
	normalizeNode,
	pruneToMembers,
	removeLeaf,
	type SplitBranch,
	setSizesAt,
	swapLeaves,
} from "./splitTree.ts";

const pair = (a: string, b: string): SplitBranch =>
	makeBranch("columns", [makeLeaf(a), makeLeaf(b)]);

describe("directions", () => {
	it("maps direction to axis and side", () => {
		expect(directionOrientation("left")).toBe("columns");
		expect(directionOrientation("right")).toBe("columns");
		expect(directionOrientation("up")).toBe("rows");
		expect(directionOrientation("down")).toBe("rows");
		expect(directionBefore("left")).toBe(true);
		expect(directionBefore("up")).toBe(true);
		expect(directionBefore("right")).toBe(false);
		expect(directionBefore("down")).toBe(false);
	});
});

describe("leafOrder / containsLeaf", () => {
	it("walks depth-first", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		expect(leafOrder(tree)).toEqual(["a", "b", "c"]);
		expect(containsLeaf(tree, "c")).toBe(true);
		expect(containsLeaf(tree, "x")).toBe(false);
	});
});

describe("insertLeaf", () => {
	it("splits a lone leaf into a perpendicular pair", () => {
		const tree = insertLeaf(makeLeaf("a"), "a", "b", "down");
		expect(tree.type).toBe("branch");
		const branch = tree as SplitBranch;
		expect(branch.orientation).toBe("rows");
		expect(leafOrder(branch)).toEqual(["a", "b"]);
	});

	it("inserts before the target for left/up", () => {
		const tree = insertLeaf(makeLeaf("a"), "a", "b", "left");
		expect(leafOrder(tree)).toEqual(["b", "a"]);
	});

	it("becomes a sibling when the parent runs along the drop axis", () => {
		const tree = insertLeaf(pair("a", "b"), "a", "c", "right") as SplitBranch;
		expect(leafOrder(tree)).toEqual(["a", "c", "b"]);
		expect(tree.children).toHaveLength(3);
		// The new sibling takes half the target's fraction: 0.25/0.25/0.5.
		expect(tree.sizes[0]).toBeCloseTo(0.25);
		expect(tree.sizes[1]).toBeCloseTo(0.25);
		expect(tree.sizes[2]).toBeCloseTo(0.5);
	});

	it("nests a perpendicular pair inside a run", () => {
		const tree = insertLeaf(pair("a", "b"), "b", "c", "down") as SplitBranch;
		expect(tree.children).toHaveLength(2);
		const nested = tree.children[1] as SplitBranch;
		expect(nested.type).toBe("branch");
		expect(nested.orientation).toBe("rows");
		expect(leafOrder(nested)).toEqual(["b", "c"]);
	});

	it("recurses into nested branches", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = insertLeaf(tree, "c", "d", "down") as SplitBranch;
		expect(leafOrder(next)).toEqual(["a", "b", "c", "d"]);
		const rows = next.children[1] as SplitBranch;
		expect(rows.children).toHaveLength(3);
	});

	it("returns the node unchanged when the target is absent", () => {
		const tree = pair("a", "b");
		expect(insertLeaf(tree, "zzz", "c", "left")).toEqual(tree);
	});
});

describe("removeLeaf", () => {
	it("collapses a pair to the survivor", () => {
		expect(removeLeaf(pair("a", "b"), "a")).toEqual(makeLeaf("b"));
	});

	it("flattens a nested branch left with one child into its parent", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = removeLeaf(tree, "c") as SplitBranch;
		expect(next.type).toBe("branch");
		expect(leafOrder(next)).toEqual(["a", "b"]);
		// The rows branch collapsed away; a+b sit flat in the columns run.
		expect(next.children.every((c) => c.type === "leaf")).toBe(true);
	});

	it("redistributes the removed fraction to the survivors", () => {
		const tree = makeBranch(
			"columns",
			[makeLeaf("a"), makeLeaf("b"), makeLeaf("c")],
			[0.5, 0.25, 0.25]
		);
		const next = removeLeaf(tree, "a") as SplitBranch;
		expect(next.sizes[0]).toBeCloseTo(0.5);
		expect(next.sizes[1]).toBeCloseTo(0.5);
	});

	it("returns null when the last leaf is removed", () => {
		expect(removeLeaf(makeLeaf("a"), "a")).toBeNull();
	});
});

describe("normalizeNode", () => {
	it("merges same-orientation nesting", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("columns", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = normalizeNode(tree) as SplitBranch;
		expect(next.children).toHaveLength(3);
		expect(leafOrder(next)).toEqual(["a", "b", "c"]);
		// The nested run's halves split their parent's half: 0.5/0.25/0.25.
		expect(next.sizes[1]).toBeCloseTo(0.25);
	});

	it("repairs degenerate sizes to equal fractions", () => {
		const tree: SplitBranch = {
			type: "branch",
			orientation: "rows",
			sizes: [0, 0],
			children: [makeLeaf("a"), makeLeaf("b")],
		};
		const next = normalizeNode(tree) as SplitBranch;
		expect(next.sizes[0]).toBeCloseTo(0.5);
	});
});

describe("pruneToMembers", () => {
	it("drops departed leaves and collapses", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = pruneToMembers(tree, new Set(["a", "b"])) as SplitBranch;
		expect(leafOrder(next)).toEqual(["a", "b"]);
	});

	it("returns null when nobody remains", () => {
		expect(pruneToMembers(pair("a", "b"), new Set())).toBeNull();
	});
});

describe("swapLeaves / setSizesAt / appendLeaves", () => {
	it("swaps two panes in place", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		expect(leafOrder(swapLeaves(tree, "a", "c"))).toEqual(["c", "b", "a"]);
	});

	it("sets sizes at a nested path only", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = setSizesAt(tree, [1], [0.7, 0.3]) as SplitBranch;
		const rows = next.children[1] as SplitBranch;
		expect(rows.sizes[0]).toBeCloseTo(0.7);
		expect(next.sizes[0]).toBeCloseTo(0.5);
	});

	it("ignores mismatched sizes", () => {
		const tree = pair("a", "b");
		expect(setSizesAt(tree, [], [1])).toEqual(tree);
	});

	it("appends missing members at the root", () => {
		const next = appendLeaves(pair("a", "b"), ["c"]);
		expect(leafOrder(next)).toEqual(["a", "b", "c"]);
		expect(next.sizes).toHaveLength(3);
	});
});
