import { describe, expect, it } from "bun:test";
import {
	BUILTIN_PRESETS,
	buildPresetTree,
	makePresetBranch,
	makeSlot,
	PANE_CHOOSER_PATH,
	parsePresets,
	presetFromSplit,
	presetPinsRoutes,
	presetSlotCount,
	presetSlots,
	presetSummary,
} from "./splitPresets.ts";
import {
	leafOrder,
	makeBranch,
	makeLeaf,
	type SplitBranch,
} from "./splitTree.ts";

/** "One tall pane beside two stacked" — the shape a flat `splitTabs` cannot
    express, and therefore the one every round-trip has to survive. */
const nested = (): SplitBranch =>
	makeBranch(
		"columns",
		[
			makeLeaf("a"),
			makeBranch("rows", [makeLeaf("b"), makeLeaf("c")], [0.7, 0.3]),
		],
		[0.6, 0.4]
	);

describe("presetSlots / presetSlotCount", () => {
	it("walks slots depth-first, matching pane order", () => {
		const preset = presetFromSplit(nested(), () => undefined);
		expect(presetSlotCount(preset)).toBe(3);
		expect(presetSlots(preset)).toHaveLength(3);
	});

	it("counts every built-in", () => {
		expect(BUILTIN_PRESETS.map((p) => presetSlotCount(p.root))).toEqual([
			2, 2, 3, 3, 4,
		]);
	});
});

describe("presetFromSplit", () => {
	it("is geometric by default — no tab ids, no routes", () => {
		const preset = presetFromSplit(nested(), () => "/chat");
		expect(presetPinsRoutes(preset)).toBe(false);
		expect(JSON.stringify(preset)).not.toContain("/chat");
		expect(JSON.stringify(preset)).not.toContain('"a"');
	});

	it("keeps orientation and fractions at every depth", () => {
		const preset = presetFromSplit(nested(), () => undefined);
		expect(preset.orientation).toBe("columns");
		expect(preset.sizes).toEqual([0.6, 0.4]);
		const inner = preset.children[1];
		if (inner?.type !== "branch") {
			throw new Error("Expected nested branch");
		}
		expect(inner.orientation).toBe("rows");
		expect(inner.sizes).toEqual([0.7, 0.3]);
	});

	it("remembers routes when asked, stripping query strings", () => {
		const paths = new Map([
			["a", "/library?section=chat"],
			["b", "/chat"],
			["c", PANE_CHOOSER_PATH],
		]);
		const preset = presetFromSplit(nested(), (id) => paths.get(id), {
			pinRoutes: true,
		});
		expect(presetSlots(preset).map((s) => s.path)).toEqual([
			"/library",
			"/chat",
			// The pane chooser is never pinned — a "remembered" empty pane is a
			// confusing no-op.
			undefined,
		]);
	});
});

describe("presetSummary", () => {
	it("names the axis of a flat shape", () => {
		const byId = (id: string) => {
			const preset = BUILTIN_PRESETS.find((p) => p.id === id);
			if (!preset) {
				throw new Error(`Missing builtin preset ${id}`);
			}
			return preset;
		};
		expect(presetSummary(byId("builtin:side-by-side"))).toBe(
			"2 panes · side by side"
		);
		expect(presetSummary(byId("builtin:stacked"))).toBe("2 panes · stacked");
	});

	it("calls a nested shape tiled, not by its root axis", () => {
		const byId = (id: string) => {
			const preset = BUILTIN_PRESETS.find((p) => p.id === id);
			if (!preset) {
				throw new Error(`Missing builtin preset ${id}`);
			}
			return preset;
		};
		// Both have a `columns` root, and neither is "side by side".
		expect(presetSummary(byId("builtin:grid"))).toBe("4 panes · tiled");
		expect(presetSummary(byId("builtin:main-and-two-stacked"))).toBe(
			"3 panes · tiled"
		);
	});
});

describe("buildPresetTree", () => {
	it("round-trips a nested split through a preset", () => {
		const original = nested();
		const preset = presetFromSplit(original, () => undefined);
		const rebuilt = buildPresetTree(preset, ["a", "b", "c"]);
		expect(rebuilt).toEqual(original);
	});

	it("fills slots in pane order", () => {
		const preset = presetFromSplit(nested(), () => undefined);
		const rebuilt = buildPresetTree(preset, ["x", "y", "z"]);
		expect(rebuilt && leafOrder(rebuilt)).toEqual(["x", "y", "z"]);
	});

	it("ignores extra ids but refuses to under-fill", () => {
		const preset = presetFromSplit(nested(), () => undefined);
		expect(buildPresetTree(preset, ["a", "b", "c", "d"])).not.toBeNull();
		expect(buildPresetTree(preset, ["a", "b"])).toBeNull();
	});

	it("builds every built-in", () => {
		for (const preset of BUILTIN_PRESETS) {
			const ids = Array.from(
				{ length: presetSlotCount(preset.root) },
				(_, i) => `t${i}`
			);
			const tree = buildPresetTree(preset.root, ids);
			expect(tree).not.toBeNull();
			expect(tree && leafOrder(tree)).toEqual(ids);
		}
	});

	it("returns null rather than a degenerate single-pane tree", () => {
		const oneSlot = makePresetBranch("columns", [makeSlot()]);
		expect(buildPresetTree(oneSlot, ["a"])).toBeNull();
	});
});

describe("parsePresets", () => {
	it("round-trips a saved preset through JSON", () => {
		const saved = [
			{
				id: "preset-1",
				name: "Review",
				createdAt: 5,
				root: presetFromSplit(nested(), () => undefined),
			},
		];
		const parsed = parsePresets(JSON.parse(JSON.stringify(saved)));
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe("Review");
		expect(presetSlotCount(parsed[0].root)).toBe(3);
	});

	it("drops junk, builtin-id squatters and duplicates", () => {
		const parsed = parsePresets([
			null,
			"nope",
			{ id: "x", name: "no root" },
			{ id: "builtin:side-by-side", name: "squatter", root: nested() },
			{
				id: "dupe",
				name: "first",
				root: makePresetBranch("columns", [makeSlot(), makeSlot()]),
			},
			{
				id: "dupe",
				name: "second",
				root: makePresetBranch("columns", [makeSlot(), makeSlot()]),
			},
		]);
		expect(parsed.map((p) => p.id)).toEqual(["dupe"]);
		expect(parsed[0].name).toBe("first");
	});

	it("keeps only route-shaped slot paths", () => {
		const parsed = parsePresets([
			{
				id: "p",
				name: "p",
				root: {
					type: "branch",
					orientation: "columns",
					sizes: [0.5, 0.5],
					children: [
						{ type: "slot", path: "/chat" },
						{ type: "slot", path: "//evil.example" },
					],
				},
			},
		]);
		expect(presetSlots(parsed[0].root).map((s) => s.path)).toEqual([
			"/chat",
			undefined,
		]);
	});

	it("rejects a preset with more panes than the cap", () => {
		const many = makePresetBranch(
			"columns",
			Array.from({ length: 20 }, () => makeSlot())
		);
		expect(parsePresets([{ id: "p", name: "p", root: many }])).toEqual([]);
	});
});

it("stored presets retain valid siblings, legacy size filtering, and bounded nesting", () => {
	expect(
		parsePresets([
			{
				id: "saved",
				name: "n".repeat(80),
				createdAt: "future",
				root: {
					type: "branch",
					orientation: "future",
					children: [
						{ type: "slot", path: "/chat" },
						null,
						{ type: "slot", path: "//external" },
					],
					sizes: [1, false, 2],
				},
			},
		])
	).toEqual([
		{
			id: "saved",
			name: "n".repeat(64),
			createdAt: 0,
			root: {
				type: "branch",
				orientation: "columns",
				children: [{ type: "slot", path: "/chat" }, { type: "slot" }],
				sizes: [1, 2],
			},
		},
	]);
	let root = makePresetBranch("columns", [makeSlot(), makeSlot()]);
	for (let depth = 0; depth < 7; depth++) {
		root = makePresetBranch("rows", [makeSlot(), root]);
	}
	expect(parsePresets([{ id: "nested", name: "Nested", root }])).toHaveLength(
		1
	);
	root = makePresetBranch("rows", [makeSlot(), root]);
	expect(parsePresets([{ id: "nested", name: "Nested", root }])).toEqual([]);
});
