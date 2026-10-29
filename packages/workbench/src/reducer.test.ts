import { expect, test } from "bun:test";
import { createDefaultWorkbench, MAX_CLOSED_ITEMS } from "./model.ts";
import { reduceWorkbench } from "./reducer.ts";

test("moves an item across all fixed regions without copying it", () => {
	let state = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	state = reduceWorkbench(state, {
		type: "item/open",
		groupId: "center-main",
		item: {
			id: "files",
			title: "Files",
			closable: true,
			duplicable: false,
			pinned: false,
			preferredRegion: "right",
			scope: { kind: "project", folder: "/tmp/project" },
			source: { kind: "shell", panel: "files" },
		},
	});
	for (const groupId of [
		"right-main",
		"bottom-main",
		"left-main",
		"center-main",
	]) {
		state = reduceWorkbench(state, {
			type: "item/move",
			itemId: "files",
			toGroupId: groupId,
		});
		expect(
			state.groups.find((group) => group.id === groupId)?.itemIds
		).toContain("files");
		expect(
			state.groups.filter((group) => group.itemIds.includes("files"))
		).toHaveLength(1);
	}
});

test("splits Center and dissolves an empty secondary group", () => {
	const initial = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	const split = reduceWorkbench(initial, {
		type: "center/split",
		targetGroupId: "center-main",
		newGroupId: "center-right",
		direction: "right",
	});
	expect(split.centerTree).toEqual({
		type: "branch",
		orientation: "columns",
		sizes: [0.5, 0.5],
		children: [
			{ type: "leaf", groupId: "center-main" },
			{ type: "leaf", groupId: "center-right" },
		],
	});
	const joined = reduceWorkbench(split, {
		type: "center/remove-group",
		groupId: "center-right",
	});
	expect(joined.centerTree).toEqual({ type: "leaf", groupId: "center-main" });
});

test("returns normalized current state for an unknown runtime action", () => {
	const initial = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	// SAFETY: This deliberately invalid discriminant verifies the reducer's runtime default branch, which reads no action payload.
	const invalidRuntimeAction = {
		type: "unknown/runtime-action",
	} as never;
	const result = reduceWorkbench(initial, invalidRuntimeAction);
	expect(result).toEqual(initial);
});

test("restores the most recently closed item when ids repeat", () => {
	const initial = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	const closedItem = {
		id: "reopened",
		title: "Older close",
		closable: true,
		duplicable: false,
		pinned: false,
		preferredRegion: "center" as const,
		scope: { kind: "window" as const },
		source: { kind: "route" as const, path: "/older" },
	};
	const restored = reduceWorkbench(
		{
			...initial,
			closedItems: [
				{ groupId: "center-main", index: 0, item: closedItem },
				{
					groupId: "center-main",
					index: 0,
					item: {
						...closedItem,
						title: "Latest close",
						source: { kind: "route", path: "/latest" },
					},
				},
			],
		},
		{ type: "item/restore", itemId: "reopened" }
	);

	expect(restored.items.find((item) => item.id === "reopened")?.title).toBe(
		"Latest close"
	);
	expect(restored.closedItems).toHaveLength(1);
	expect(restored.closedItems[0]?.item.title).toBe("Older close");
});

test("updates item metadata without changing its group ownership", () => {
	let state = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	state = reduceWorkbench(state, {
		type: "item/open",
		groupId: "center-main",
		item: {
			id: "route",
			title: "Settings",
			closable: true,
			duplicable: true,
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "window" },
			source: { kind: "route", path: "/settings" },
		},
	});
	const action = {
		type: "item/update",
		item: {
			id: "route",
			title: "Conversation",
			closable: true,
			duplicable: true,
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "conversation", conversationId: "c1" },
			source: { kind: "route", path: "/chat" },
		},
	} satisfies Parameters<typeof reduceWorkbench>[1];
	const updated = reduceWorkbench(state, action);

	expect(updated.items.find((item) => item.id === "route")).toMatchObject({
		title: "Conversation",
		scope: { kind: "conversation", conversationId: "c1" },
		source: { kind: "route", path: "/chat" },
	});
	expect(
		updated.groups.find((group) => group.id === "center-main")?.itemIds
	).toEqual(["route"]);
});

test("replaces Center geometry with a validated flat tree", () => {
	let state = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	state = reduceWorkbench(state, {
		type: "center/split",
		targetGroupId: "center-main",
		newGroupId: "center-second",
		direction: "right",
	});
	state = reduceWorkbench(state, {
		type: "center/split",
		targetGroupId: "center-second",
		newGroupId: "center-third",
		direction: "right",
	});
	const tree = {
		type: "branch" as const,
		orientation: "columns" as const,
		sizes: [1 / 3, 1 / 3, 1 / 3],
		children: [
			{ type: "leaf" as const, groupId: "center-main" },
			{ type: "leaf" as const, groupId: "center-second" },
			{ type: "leaf" as const, groupId: "center-third" },
		],
	};
	const action = {
		type: "center/replace-tree",
		tree,
	} satisfies Parameters<typeof reduceWorkbench>[1];
	const replaced = reduceWorkbench(state, action);

	expect(replaced.centerTree).toEqual(tree);
});

test("moves an item in the background without stealing destination focus", () => {
	let state = createDefaultWorkbench({
		centerGroupId: "center-main",
		navigationId: "navigation",
		leftGroupId: "left-main",
		rightGroupId: "right-main",
		bottomGroupId: "bottom-main",
	});
	for (const id of ["active", "background"]) {
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId: "center-main",
			item: {
				id,
				title: id,
				closable: true,
				duplicable: true,
				pinned: false,
				preferredRegion: "center",
				scope: { kind: "window" },
				source: { kind: "route", path: `/${id}` },
			},
		});
	}
	state = reduceWorkbench(state, { type: "item/activate", itemId: "active" });
	state = reduceWorkbench(state, {
		type: "center/split",
		targetGroupId: "center-main",
		newGroupId: "center-secondary",
		direction: "right",
	});
	state = reduceWorkbench(state, {
		type: "item/open",
		groupId: "center-secondary",
		item: {
			id: "detached",
			title: "detached",
			closable: true,
			duplicable: true,
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "window" },
			source: { kind: "route", path: "/detached" },
		},
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		activate: false,
		itemId: "detached",
		toGroupId: "center-main",
	});

	expect(
		state.groups.find((group) => group.id === "center-main")
	).toMatchObject({
		activeItemId: "active",
		itemIds: ["active", "background", "detached"],
	});
	expect(state.focusedGroupId).toBe("center-secondary");
});

function defaultIds() {
	return {
		bottomGroupId: "bottom-main",
		centerGroupId: "center-main",
		leftGroupId: "left-main",
		navigationId: "navigation",
		rightGroupId: "right-main",
	};
}

function routeItem(id: string, pinned = false) {
	return {
		closable: true,
		duplicable: true,
		id,
		pinned,
		preferredRegion: "center" as const,
		scope: { kind: "window" as const },
		source: { kind: "route" as const, path: `/${id}` },
		title: id,
	};
}

function openAll(ids: string[], groupId = "center-main") {
	let state = createDefaultWorkbench(defaultIds());
	for (const id of ids) {
		state = reduceWorkbench(state, {
			type: "item/open",
			groupId,
			item: routeItem(id),
		});
	}
	return state;
}

function group(state: ReturnType<typeof openAll>, id: string) {
	return state.groups.find((candidate) => candidate.id === id);
}

test("closing or moving the active tab activates its neighbor, not the first tab", () => {
	let state = openAll(["a", "b", "c", "d"]);
	state = reduceWorkbench(state, { type: "item/activate", itemId: "c" });
	state = reduceWorkbench(state, { type: "item/close", itemId: "c" });
	expect(group(state, "center-main")?.activeItemId).toBe("d");
	state = reduceWorkbench(state, { type: "item/close", itemId: "d" });
	expect(group(state, "center-main")?.activeItemId).toBe("b");
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "b",
		toGroupId: "right-main",
	});
	expect(group(state, "center-main")?.activeItemId).toBe("a");
});

test("activating or moving a tab into a hidden region shows that region", () => {
	let state = openAll(["a", "b"]);
	state = reduceWorkbench(state, {
		type: "item/move",
		activate: false,
		itemId: "b",
		toGroupId: "bottom-main",
	});
	expect(state.openRegions.bottom).toBe(false);
	state = reduceWorkbench(state, { type: "item/activate", itemId: "b" });
	expect(state.openRegions.bottom).toBe(true);
	expect(state.focusedGroupId).toBe("bottom-main");
	state = reduceWorkbench(state, { type: "region/hide", region: "bottom" });
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "a",
		toGroupId: "right-main",
	});
	expect(state.openRegions.right).toBe(true);
});

test("keeps pinned tabs ahead of unpinned tabs in every group", () => {
	let state = openAll(["a", "b", "c"]);
	state = reduceWorkbench(state, {
		type: "item/pin",
		itemId: "c",
		pinned: true,
	});
	expect(group(state, "center-main")?.itemIds).toEqual(["c", "a", "b"]);
	state = reduceWorkbench(state, {
		type: "item/reorder",
		groupId: "center-main",
		itemId: "b",
		toIndex: 0,
	});
	expect(group(state, "center-main")?.itemIds).toEqual(["c", "b", "a"]);
});

test("removing a Center group merges into and resizes its neighbor only", () => {
	let state = openAll(["a", "b", "c"]);
	state = reduceWorkbench(state, {
		type: "center/split",
		direction: "right",
		newGroupId: "center-2",
		targetGroupId: "center-main",
	});
	state = reduceWorkbench(state, {
		type: "center/split",
		direction: "right",
		newGroupId: "center-3",
		targetGroupId: "center-2",
	});
	state = reduceWorkbench(state, {
		type: "center/replace-tree",
		tree: {
			type: "branch",
			orientation: "columns",
			children: [
				{ type: "leaf", groupId: "center-main" },
				{ type: "leaf", groupId: "center-2" },
				{ type: "leaf", groupId: "center-3" },
			],
			sizes: [0.5, 0.3, 0.2],
		},
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "c",
		toGroupId: "center-3",
	});
	state = reduceWorkbench(state, {
		type: "center/remove-group",
		groupId: "center-3",
	});
	expect(state.centerTree).toEqual({
		type: "branch",
		orientation: "columns",
		children: [
			{ type: "leaf", groupId: "center-main" },
			{ type: "leaf", groupId: "center-2" },
		],
		sizes: [0.5, 0.5],
	});
	expect(group(state, "center-2")?.itemIds).toEqual(["c"]);
	state = reduceWorkbench(state, {
		type: "center/remove-group",
		groupId: "center-main",
	});
	expect(group(state, "center-2")?.itemIds).toEqual(["c", "a", "b"]);
	expect(state.centerTree).toEqual({ type: "leaf", groupId: "center-2" });
});

test("reset layout returns every item, including a moved Navigation, to its preferred region", () => {
	let state = openAll(["a", "b"]);
	state = reduceWorkbench(state, {
		type: "center/split",
		direction: "down",
		newGroupId: "center-2",
		targetGroupId: "center-main",
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "b",
		toGroupId: "center-2",
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "a",
		toGroupId: "right-main",
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "navigation",
		toGroupId: "bottom-main",
	});
	state = reduceWorkbench(state, { type: "item/activate", itemId: "b" });
	state = reduceWorkbench(state, { type: "layout/reset" });

	expect(state.centerTree).toEqual({ type: "leaf", groupId: "center-2" });
	expect(group(state, "left-main")?.itemIds).toEqual(["navigation"]);
	expect(group(state, "center-2")?.itemIds).toEqual(["b", "a"]);
	expect(group(state, "center-2")?.activeItemId).toBe("b");
	expect(group(state, "right-main")?.itemIds).toEqual([]);
	expect(group(state, "bottom-main")?.itemIds).toEqual([]);
	expect(state.openRegions).toEqual({
		bottom: false,
		center: true,
		left: true,
		right: false,
	});
	expect(state.items.map((item) => item.id).sort()).toEqual([
		"a",
		"b",
		"navigation",
	]);
});

test("an item opened into an unknown group lands in its preferred region", () => {
	const state = reduceWorkbench(createDefaultWorkbench(defaultIds()), {
		type: "item/open",
		groupId: "missing-group",
		item: routeItem("a"),
	});
	expect(group(state, "center-main")?.itemIds).toEqual(["a"]);
});

test("bounds the runtime close history", () => {
	let state = openAll(Array.from({ length: 60 }, (_, index) => `t${index}`));
	for (let index = 0; index < 60; index += 1) {
		state = reduceWorkbench(state, { type: "item/close", itemId: `t${index}` });
	}
	expect(state.closedItems).toHaveLength(MAX_CLOSED_ITEMS);
	expect(state.closedItems.at(-1)?.item.id).toBe("t59");
});

test("reset keeps the focused Center tab active when several groups had one", () => {
	let state = openAll(["a", "b"]);
	state = reduceWorkbench(state, {
		type: "center/split",
		direction: "right",
		newGroupId: "center-2",
		targetGroupId: "center-main",
	});
	state = reduceWorkbench(state, {
		type: "item/move",
		itemId: "b",
		toGroupId: "center-2",
	});
	state = reduceWorkbench(state, { type: "item/activate", itemId: "b" });
	expect(group(state, "center-main")?.activeItemId).toBe("a");
	state = reduceWorkbench(state, { type: "layout/reset" });
	expect(group(state, "center-2")?.itemIds).toEqual(["a", "b"]);
	expect(group(state, "center-2")?.activeItemId).toBe("b");
});

test("opens an item in the background without focusing or revealing its region", () => {
	const state = reduceWorkbench(openAll(["a"]), {
		type: "item/open",
		activate: false,
		groupId: "bottom-main",
		item: { ...routeItem("logs"), preferredRegion: "bottom" },
	});
	expect(group(state, "bottom-main")?.itemIds).toEqual(["logs"]);
	expect(state.focusedGroupId).toBe("center-main");
	expect(state.openRegions.bottom).toBe(false);
});
