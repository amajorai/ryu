import { describe, expect, test } from "bun:test";
import type { Split, Tab, TabGroup } from "@/src/contexts/TabsContext.tsx";
import {
	createInitialTabCanvasSnapshot,
	reconcileTabCanvasSnapshot,
} from "./tab-canvas-layout.ts";

const tabs: Tab[] = [
	{ id: "tab-a", path: "/chat", title: "Alpha" },
	{ id: "tab-b", path: "/chat", title: "Beta", groupId: "group-a" },
	{ id: "tab-c", path: "/chat", title: "Gamma", groupId: "group-a" },
	{ id: "tab-d", path: "/chat", title: "Delta", splitId: "split-a" },
	{ id: "tab-e", path: "/chat", title: "Epsilon", splitId: "split-a" },
];

const groups: TabGroup[] = [
	{ collapsed: false, color: "blue", id: "group-a", name: "Research" },
];

const splits: Split[] = [
	{
		collapsed: false,
		color: "green",
		id: "split-a",
		name: "Pair",
		root: {
			children: [
				{ tabId: "tab-d", type: "leaf" },
				{ tabId: "tab-e", type: "leaf" },
			],
			orientation: "columns",
			sizes: [0.5, 0.5],
			type: "branch",
		},
	},
];

describe("tab canvas layout", () => {
	test("places grouped and split tabs inside deterministic regions", () => {
		const snapshot = createInitialTabCanvasSnapshot(tabs, groups, splits);

		expect(snapshot.version).toBe(1);
		expect(snapshot.groups["group:group-a"]).toBeDefined();
		expect(snapshot.groups["split:split-a"]).toBeDefined();
		expect(snapshot.tabs["tab-a"]).toEqual({
			height: 280,
			width: 420,
			x: 24,
			y: 64,
		});
		expect(snapshot.tabs["tab-b"]?.x).toBe(24);
		expect(snapshot.tabs["tab-c"]?.x).toBe(500);
		expect(snapshot.tabs["tab-b"]?.y).toBe(snapshot.tabs["tab-c"]?.y);
	});

	test("preserves valid geometry and prunes removed ids", () => {
		const snapshot = reconcileTabCanvasSnapshot(
			{
				groups: {
					"group:group-a": {
						height: 510,
						width: 900,
						x: -80,
						y: 120,
					},
					"group:stale": {
						height: 200,
						width: 200,
						x: 0,
						y: 0,
					},
				},
				tabs: {
					"tab-a": { height: 280, width: 420, x: 36, y: 72 },
					"tab-stale": { height: 280, width: 420, x: 0, y: 0 },
				},
				version: 1,
				viewport: { x: 24, y: -18, zoom: 0.8 },
			},
			["tab-a", "tab-b"],
			["group:group-a"]
		);

		expect(snapshot.tabs["tab-a"]).toEqual({
			height: 280,
			width: 420,
			x: 36,
			y: 72,
		});
		expect(snapshot.tabs["tab-stale"]).toBeUndefined();
		expect(snapshot.groups["group:stale"]).toBeUndefined();
		expect(snapshot.groups["group:group-a"]).toEqual({
			height: 510,
			width: 900,
			x: -80,
			y: 120,
		});
		expect(snapshot.viewport).toEqual({ x: 24, y: -18, zoom: 0.8 });
	});

	test("repairs malformed rectangles and viewport values", () => {
		const snapshot = reconcileTabCanvasSnapshot(
			{
				groups: {
					"group:group-a": {
						height: Number.NaN,
						width: 99_999,
						x: Number.POSITIVE_INFINITY,
						y: 30,
					},
				},
				tabs: {
					"tab-a": { height: -4, width: 1, x: 8, y: 12 },
				},
				version: 99,
				viewport: { x: "bad", y: null, zoom: 99 },
			},
			["tab-a"],
			["group:group-a"]
		);

		expect(snapshot.tabs["tab-a"]).toEqual({
			height: 240,
			width: 360,
			x: 8,
			y: 12,
		});
		expect(snapshot.groups["group:group-a"]?.width).toBe(1200);
		expect(snapshot.groups["group:group-a"]?.height).toBe(368);
		expect(snapshot.groups["group:group-a"]?.x).toBe(0);
		expect(snapshot.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
	});
});

test("saved canvas parsing repairs entries independently and resets nonobject snapshots", () => {
	const malformed = reconcileTabCanvasSnapshot(
		{
			tabs: {
				good: { x: -120, y: 44, width: 600, height: 300 },
				broken: null,
				partial: {
					x: "24",
					y: 70,
					width: Number.POSITIVE_INFINITY,
					height: 500,
				},
			},
			groups: "invalid",
			viewport: { x: -10, y: Number.NaN, zoom: 0.2 },
		},
		["good", "broken", "partial"],
		["group:new"]
	);
	expect(malformed.tabs.good).toEqual({
		x: -120,
		y: 44,
		width: 600,
		height: 300,
	});
	expect(malformed.tabs.broken).toEqual({
		x: 500,
		y: 64,
		width: 420,
		height: 280,
	});
	expect(malformed.tabs.partial).toEqual({
		x: 24,
		y: 70,
		width: 420,
		height: 500,
	});
	expect(malformed.viewport).toEqual({ x: -10, y: 0, zoom: 0.2 });
	expect(reconcileTabCanvasSnapshot(null, ["good"], [])).toEqual({
		version: 1,
		groups: {},
		tabs: { good: { x: 24, y: 64, width: 420, height: 280 } },
		viewport: { x: 0, y: 0, zoom: 1 },
	});
});
