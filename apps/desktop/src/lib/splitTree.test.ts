import { describe, expect, it } from "bun:test";
import {
	appendLeaves,
	containsLeaf,
	directionBefore,
	directionOrientation,
	equalizeNode,
	equalSizes,
	insertLeaf,
	isEqualized,
	leafOrder,
	makeBranch,
	makeLeaf,
	normalizeNode,
	pruneToMembers,
	removeLeaf,
	replaceLeaf,
	type SplitBranch,
	type SplitNode,
	setSizesAt,
	swapLeaves,
} from "./splitTree.ts";

function requireBranch(node: SplitNode | null | undefined): SplitBranch {
	if (node?.type !== "branch") {
		throw new Error("Expected a split branch from this tree operation");
	}
	return node;
}

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
		const branch = requireBranch(tree);
		expect(branch.orientation).toBe("rows");
		expect(leafOrder(branch)).toEqual(["a", "b"]);
	});

	it("inserts before the target for left/up", () => {
		const tree = insertLeaf(makeLeaf("a"), "a", "b", "left");
		expect(leafOrder(tree)).toEqual(["b", "a"]);
	});

	it("becomes a sibling when the parent runs along the drop axis", () => {
		const tree = requireBranch(insertLeaf(pair("a", "b"), "a", "c", "right"));
		expect(leafOrder(tree)).toEqual(["a", "c", "b"]);
		expect(tree.children).toHaveLength(3);
		// The new sibling takes half the target's fraction: 0.25/0.25/0.5.
		expect(tree.sizes[0]).toBeCloseTo(0.25);
		expect(tree.sizes[1]).toBeCloseTo(0.25);
		expect(tree.sizes[2]).toBeCloseTo(0.5);
	});

	it("nests a perpendicular pair inside a run", () => {
		const tree = requireBranch(insertLeaf(pair("a", "b"), "b", "c", "down"));
		expect(tree.children).toHaveLength(2);
		const nested = requireBranch(tree.children[1]);
		expect(nested.type).toBe("branch");
		expect(nested.orientation).toBe("rows");
		expect(leafOrder(nested)).toEqual(["b", "c"]);
	});

	it("recurses into nested branches", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = requireBranch(insertLeaf(tree, "c", "d", "down"));
		expect(leafOrder(next)).toEqual(["a", "b", "c", "d"]);
		const rows = requireBranch(next.children[1]);
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
		const next = requireBranch(removeLeaf(tree, "c"));
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
		const next = requireBranch(removeLeaf(tree, "a"));
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
		const next = requireBranch(normalizeNode(tree));
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
		const next = requireBranch(normalizeNode(tree));
		expect(next.sizes[0]).toBeCloseTo(0.5);
	});
});

describe("pruneToMembers", () => {
	it("drops departed leaves and collapses", () => {
		const tree = makeBranch("columns", [
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")]),
		]);
		const next = requireBranch(pruneToMembers(tree, new Set(["a", "b"])));
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
		const next = requireBranch(setSizesAt(tree, [1], [0.7, 0.3]));
		const rows = requireBranch(next.children[1]);
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

describe("equalizeNode", () => {
	const skewed = () =>
		makeBranch(
			"columns",
			[
				makeLeaf("a"),
				makeBranch(
					"rows",
					[makeLeaf("b"), makeLeaf("c"), makeLeaf("d")],
					[0.8, 0.15, 0.05]
				),
			],
			[0.9, 0.1]
		);

	it("evens every branch at every depth", () => {
		const next = requireBranch(equalizeNode(skewed()));
		expect(next.sizes).toEqual(equalSizes(2));
		expect(requireBranch(next.children[1]).sizes).toEqual(equalSizes(3));
	});

	it("leaves structure, orientation and pane order untouched", () => {
		const before = skewed();
		const next = requireBranch(equalizeNode(before));
		expect(leafOrder(next)).toEqual(leafOrder(before));
		expect(next.orientation).toBe("columns");
		expect(requireBranch(next.children[1]).orientation).toBe("rows");
		// Pure — the input is never mutated.
		expect(before.sizes).toEqual([0.9, 0.1]);
	});

	it("is a no-op on a bare leaf", () => {
		const leaf = makeLeaf("a");
		expect(equalizeNode(leaf)).toEqual(leaf);
	});
});

describe("isEqualized", () => {
	it("spots a skewed branch at any depth", () => {
		const outer = makeBranch(
			"columns",
			[
				makeLeaf("a"),
				makeBranch("rows", [makeLeaf("b"), makeLeaf("c")], [0.8, 0.2]),
			],
			[0.5, 0.5]
		);
		expect(isEqualized(outer)).toBe(false);
	});

	it("agrees with equalizeNode — its output is always equalized", () => {
		const skewed = makeBranch(
			"columns",
			[
				makeLeaf("a"),
				makeBranch("rows", [makeLeaf("b"), makeLeaf("c")], [0.7, 0.3]),
			],
			[0.9, 0.1]
		);
		expect(isEqualized(skewed)).toBe(false);
		expect(isEqualized(equalizeNode(skewed))).toBe(true);
	});

	it("tolerates the float drift a gutter drag leaves behind", () => {
		const thirds = makeBranch(
			"columns",
			[makeLeaf("a"), makeLeaf("b"), makeLeaf("c")],
			[0.3334, 0.3333, 0.3333]
		);
		expect(isEqualized(thirds)).toBe(true);
	});
});

describe("replaceLeaf", () => {
	it("swaps an occupant without disturbing sizes or shape", () => {
		const tree = makeBranch(
			"columns",
			[makeLeaf("a"), makeBranch("rows", [makeLeaf("b"), makeLeaf("c")])],
			[0.7, 0.3]
		);
		const next = requireBranch(replaceLeaf(tree, "b", "z"));
		expect(leafOrder(next)).toEqual(["a", "z", "c"]);
		expect(next.sizes).toEqual([0.7, 0.3]);
	});

	it("ignores a tab id that isn't in the tree", () => {
		const tree = pair("a", "b");
		expect(replaceLeaf(tree, "nope", "z")).toEqual(tree);
	});
});
