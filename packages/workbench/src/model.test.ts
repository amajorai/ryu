import { describe, expect, test } from "bun:test";
import {
	createDefaultWorkbench,
	normalizeWorkbench,
	visibleItemsForScope,
} from "./model.ts";

describe("workbench model", () => {
	test("starts with Navigation in Left and an empty Center group", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		expect(state.items.find((item) => item.id === "navigation")?.closable).toBe(
			false
		);
		expect(
			state.groups.find((group) => group.id === "left-main")?.itemIds
		).toEqual(["navigation"]);
		expect(
			state.groups.find((group) => group.id === "center-main")?.itemIds
		).toEqual([]);
		expect(state.centerTree).toEqual({ type: "leaf", groupId: "center-main" });
	});

	test("repairs duplicate ownership and a missing active item", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		const broken = {
			...state,
			groups: state.groups.map((group) =>
				group.id === "right-main"
					? { ...group, itemIds: ["navigation"], activeItemId: "missing" }
					: group
			),
		};
		const repaired = normalizeWorkbench(broken);
		expect(
			repaired.groups.filter((group) => group.itemIds.includes("navigation"))
		).toHaveLength(1);
		expect(
			repaired.groups.find((group) => group.id === "right-main")?.activeItemId
		).toBeNull();
	});

	test("repairs focus from an empty surrounding group to visible Center", () => {
		const state = createDefaultWorkbench({
			bottomGroupId: "bottom-main",
			centerGroupId: "center-main",
			leftGroupId: "left-main",
			navigationId: "navigation",
			rightGroupId: "right-main",
		});
		const repaired = normalizeWorkbench({
			...state,
			focusedGroupId: "right-main",
			openRegions: { ...state.openRegions, right: true },
		});

		expect(repaired.focusedGroupId).toBe("center-main");
		expect(
			repaired.groups.find((group) => group.id === repaired.focusedGroupId)
				?.region
		).toBe("center");
	});

	test("coalesces duplicate fixed-region groups without duplicating ownership", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		const fixedItems = [
			"left-extra",
			"right-primary",
			"right-secondary",
			"bottom-primary",
			"bottom-secondary",
		].map((id) => ({
			closable: true,
			duplicable: false,
			id,
			pinned: false,
			preferredRegion: "center" as const,
			scope: { kind: "window" as const },
			source: { kind: "shell" as const, panel: id },
			title: id,
		}));
		const broken = {
			...state,
			items: [...state.items, ...fixedItems],
			groups: [
				{
					...state.groups[0]!,
					itemIds: ["navigation", "left-extra"],
				},
				{
					activeItemId: "left-extra",
					id: "left-secondary",
					itemIds: ["left-extra"],
					locked: false,
					region: "left" as const,
				},
				state.groups[1]!,
				{
					...state.groups[2]!,
					itemIds: ["right-primary"],
				},
				{
					activeItemId: "right-secondary",
					id: "right-secondary",
					itemIds: ["right-secondary"],
					locked: false,
					region: "right" as const,
				},
				{
					...state.groups[3]!,
					itemIds: ["bottom-primary"],
				},
				{
					activeItemId: "bottom-secondary",
					id: "bottom-secondary",
					itemIds: ["bottom-secondary"],
					locked: false,
					region: "bottom" as const,
				},
			],
		};
		const repaired = normalizeWorkbench(broken);
		for (const region of ["left", "right", "bottom"] as const) {
			expect(
				repaired.groups.filter((group) => group.region === region)
			).toHaveLength(1);
		}
		for (const itemId of fixedItems.map((item) => item.id)) {
			expect(
				repaired.groups.filter((group) => group.itemIds.includes(itemId))
			).toHaveLength(1);
		}
		expect(
			repaired.groups.find((group) => group.region === "right")?.itemIds
		).toEqual(["right-primary", "right-secondary"]);
		expect(
			repaired.groups.find((group) => group.region === "bottom")?.itemIds
		).toEqual(["bottom-primary", "bottom-secondary"]);
	});

	test("creates missing fixed-region groups", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		const repaired = normalizeWorkbench({
			...state,
			groups: state.groups.filter(
				(group) => group.region !== "right" && group.region !== "bottom"
			),
		});
		expect(
			repaired.groups.filter((group) => group.region === "right")
		).toHaveLength(1);
		expect(
			repaired.groups.filter((group) => group.region === "bottom")
		).toHaveLength(1);
	});

	test("repairs malformed Navigation item properties while preserving its identity", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		const repaired = normalizeWorkbench({
			...state,
			items: state.items.map((item) =>
				item.source.kind === "navigation"
					? {
							...item,
							closable: true,
							duplicable: true,
							preferredRegion: "right",
							scope: { kind: "project", folder: "/tmp/project" } as const,
							title: "Custom Navigation",
						}
					: item
			),
		});
		const navigation = repaired.items.find(
			(item) => item.source.kind === "navigation"
		);
		expect(navigation).toMatchObject({
			closable: false,
			duplicable: false,
			id: "navigation",
			preferredRegion: "left",
			scope: { kind: "window" },
			title: "Custom Navigation",
		});
	});

	test("keeps window items plus items in the requested exact scope visible", () => {
		const state = createDefaultWorkbench({
			centerGroupId: "center-main",
			navigationId: "navigation",
			leftGroupId: "left-main",
			rightGroupId: "right-main",
			bottomGroupId: "bottom-main",
		});
		const visibleIds = visibleItemsForScope(
			{
				...state,
				items: [
					...state.items,
					{
						closable: true,
						duplicable: false,
						id: "project-a",
						pinned: false,
						preferredRegion: "center",
						scope: { kind: "project", folder: "/tmp/a" },
						source: { kind: "route", path: "/a" },
						title: "Project A",
					},
					{
						closable: true,
						duplicable: false,
						id: "project-b",
						pinned: false,
						preferredRegion: "center",
						scope: { kind: "project", folder: "/tmp/b" },
						source: { kind: "route", path: "/b" },
						title: "Project B",
					},
				],
			},
			{ kind: "project", folder: "/tmp/a" }
		).map((item) => item.id);
		expect(visibleIds).toEqual(["navigation", "project-a"]);
	});
});
