export type WorkbenchRegion = "left" | "center" | "right" | "bottom";

export type BottomAlignment = "center" | "full" | "left" | "right";

export type WorkbenchScope =
	| { kind: "window" }
	| { kind: "project"; folder: string }
	| { kind: "conversation"; conversationId: string };

export type WorkbenchItemSource =
	| { kind: "route"; path: string }
	| { kind: "shell"; panel: string }
	| { kind: "plugin"; panelId: string; pluginId: string }
	| { kind: "navigation" };

export interface WorkbenchItem {
	closable: boolean;
	duplicable: boolean;
	id: string;
	pinned: boolean;
	preferredRegion: WorkbenchRegion;
	scope: WorkbenchScope;
	source: WorkbenchItemSource;
	title: string;
}

export interface WorkbenchGroup {
	activeItemId: string | null;
	id: string;
	itemIds: string[];
	locked: boolean;
	region: WorkbenchRegion;
}

export type WorkbenchSplitNode =
	| { type: "leaf"; groupId: string }
	| {
			type: "branch";
			orientation: "columns" | "rows";
			children: WorkbenchSplitNode[];
			sizes: number[];
	  };

export interface WorkbenchState {
	bottomAlignment: BottomAlignment;
	centerTree: WorkbenchSplitNode;
	closedItems: Array<{ groupId: string; index: number; item: WorkbenchItem }>;
	focusedGroupId: string;
	groups: WorkbenchGroup[];
	items: WorkbenchItem[];
	openRegions: Record<WorkbenchRegion, boolean>;
	sizes: { bottom: number; left: number; right: number };
	version: 2;
}

export interface DefaultWorkbenchIds {
	bottomGroupId: string;
	centerGroupId: string;
	leftGroupId: string;
	navigationId: string;
	rightGroupId: string;
}

/** Fresh-layout sizes; also what double-clicking a region boundary restores. */
export const WORKBENCH_DEFAULT_SIZES = {
	bottom: 280,
	left: 288,
	right: 360,
} as const;
const DEFAULT_SIZES = WORKBENCH_DEFAULT_SIZES;
/** Close history is runtime-only; keep enough for repeated reopen without unbounded growth. */
export const MAX_CLOSED_ITEMS = 50;
export const WORKBENCH_SIZE_BOUNDS = {
	bottom: { maximum: 640, minimum: 160 },
	left: { maximum: 520, minimum: 220 },
	right: { maximum: 720, minimum: 260 },
} as const;

function cloneItem(item: WorkbenchItem): WorkbenchItem {
	return {
		...item,
		scope: { ...item.scope },
		source: { ...item.source },
	};
}

function uniqueId(baseId: string, usedIds: Set<string>): string {
	if (!usedIds.has(baseId)) {
		return baseId;
	}

	let suffix = 2;
	while (usedIds.has(`${baseId}-${suffix}`)) {
		suffix += 1;
	}
	return `${baseId}-${suffix}`;
}

function clampSize(
	value: number,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(maximum, Math.max(minimum, value));
}

function normalizeBranchSizes(sizes: number[], childCount: number): number[] {
	if (childCount === 0) {
		return [];
	}

	const positiveSizes = Array.from({ length: childCount }, (_, index) => {
		const size = sizes[index] ?? 1;
		return Number.isFinite(size) && size > 0 ? size : 1;
	});
	const total = positiveSizes.reduce((sum, size) => sum + size, 0);
	return positiveSizes.map((size) => size / total);
}

function centerGroupIdsFromTree(tree: WorkbenchSplitNode): string[] {
	if (tree.type === "leaf") {
		return [tree.groupId];
	}
	return tree.children.flatMap(centerGroupIdsFromTree);
}

function centerLeaf(groupId: string): WorkbenchSplitNode {
	return { type: "leaf", groupId };
}

function normalizeCenterTree(
	tree: WorkbenchSplitNode,
	centerGroupIds: Set<string>,
	fallbackGroupId: string
): WorkbenchSplitNode {
	if (tree.type === "leaf") {
		return centerGroupIds.has(tree.groupId)
			? { type: "leaf", groupId: tree.groupId }
			: { type: "leaf", groupId: fallbackGroupId };
	}

	const children = tree.children
		.map((child) => normalizeCenterTree(child, centerGroupIds, fallbackGroupId))
		.filter(
			(child, index, allChildren) =>
				child.type !== "leaf" ||
				allChildren.findIndex(
					(candidate) =>
						candidate.type === "leaf" && candidate.groupId === child.groupId
				) === index
		);

	if (children.length === 0) {
		return { type: "leaf", groupId: fallbackGroupId };
	}
	if (children.length === 1) {
		return children[0] ?? { type: "leaf", groupId: fallbackGroupId };
	}

	return {
		type: "branch",
		orientation: tree.orientation,
		children,
		sizes: normalizeBranchSizes(tree.sizes, children.length),
	};
}

function removeDuplicateCenterLeaves(
	tree: WorkbenchSplitNode,
	seenGroupIds = new Set<string>()
): WorkbenchSplitNode | null {
	if (tree.type === "leaf") {
		if (seenGroupIds.has(tree.groupId)) {
			return null;
		}
		seenGroupIds.add(tree.groupId);
		return tree;
	}

	const children = tree.children.flatMap((child) => {
		const uniqueChild = removeDuplicateCenterLeaves(child, seenGroupIds);
		return uniqueChild ? [uniqueChild] : [];
	});
	if (children.length === 0) {
		return null;
	}
	if (children.length === 1) {
		return children[0] ?? null;
	}
	return {
		...tree,
		children,
		sizes: normalizeBranchSizes(tree.sizes, children.length),
	};
}

function appendCenterGroups(
	tree: WorkbenchSplitNode,
	groups: WorkbenchGroup[]
): WorkbenchSplitNode {
	if (groups.length === 0) {
		return tree;
	}
	const children: WorkbenchSplitNode[] = [
		tree,
		...groups.map((group) => centerLeaf(group.id)),
	];
	return {
		type: "branch",
		children,
		orientation: "columns",
		sizes: normalizeBranchSizes([], children.length),
	};
}

function navigationItem(id: string): WorkbenchItem {
	return {
		closable: false,
		duplicable: false,
		id,
		pinned: true,
		preferredRegion: "left",
		scope: { kind: "window" },
		source: { kind: "navigation" },
		title: "Navigation",
	};
}

function fixedGroup(
	region: Exclude<WorkbenchRegion, "center">,
	id: string
): WorkbenchGroup {
	return {
		activeItemId: null,
		id,
		itemIds: [],
		locked: false,
		region,
	};
}

function coalesceFixedRegionGroups(
	groups: WorkbenchGroup[],
	groupIds: Set<string>,
	region: Exclude<WorkbenchRegion, "center">
): WorkbenchGroup {
	const matchingGroups = groups.filter((group) => group.region === region);
	const retainedGroup = matchingGroups[0];
	if (!retainedGroup) {
		const id = uniqueId(`${region}-main`, groupIds);
		groupIds.add(id);
		const group = fixedGroup(region, id);
		if (region === "left") {
			groups.unshift(group);
		} else {
			groups.push(group);
		}
		return group;
	}

	retainedGroup.itemIds = matchingGroups.flatMap((group) => group.itemIds);
	for (const group of matchingGroups.slice(1)) {
		groupIds.delete(group.id);
		const index = groups.indexOf(group);
		groups.splice(index, 1);
	}
	return retainedGroup;
}

export function createDefaultWorkbench(
	ids: DefaultWorkbenchIds
): WorkbenchState {
	return {
		bottomAlignment: "center",
		centerTree: { type: "leaf", groupId: ids.centerGroupId },
		closedItems: [],
		focusedGroupId: ids.centerGroupId,
		groups: [
			{
				activeItemId: ids.navigationId,
				id: ids.leftGroupId,
				itemIds: [ids.navigationId],
				locked: false,
				region: "left",
			},
			{
				activeItemId: null,
				id: ids.centerGroupId,
				itemIds: [],
				locked: false,
				region: "center",
			},
			{
				activeItemId: null,
				id: ids.rightGroupId,
				itemIds: [],
				locked: false,
				region: "right",
			},
			{
				activeItemId: null,
				id: ids.bottomGroupId,
				itemIds: [],
				locked: false,
				region: "bottom",
			},
		],
		items: [navigationItem(ids.navigationId)],
		openRegions: { bottom: false, center: true, left: true, right: false },
		sizes: { ...DEFAULT_SIZES },
		version: 2,
	};
}

export function normalizeWorkbench(state: WorkbenchState): WorkbenchState {
	const itemIds = new Set<string>();
	const items: WorkbenchItem[] = [];
	let navigationId: string | null = null;

	for (const item of state.items) {
		if (itemIds.has(item.id)) {
			continue;
		}
		if (item.source.kind === "navigation") {
			if (navigationId !== null) {
				continue;
			}
			navigationId = item.id;
			itemIds.add(item.id);
			items.push({
				...cloneItem(item),
				closable: false,
				duplicable: false,
				preferredRegion: "left",
				scope: { kind: "window" },
			});
			continue;
		}
		itemIds.add(item.id);
		items.push(cloneItem(item));
	}

	const groupIds = new Set<string>();
	const groups: WorkbenchGroup[] = [];
	for (const group of state.groups) {
		if (groupIds.has(group.id)) {
			continue;
		}
		groupIds.add(group.id);
		groups.push({ ...group, itemIds: [...group.itemIds] });
	}

	const leftGroup = coalesceFixedRegionGroups(groups, groupIds, "left");
	coalesceFixedRegionGroups(groups, groupIds, "right");
	coalesceFixedRegionGroups(groups, groupIds, "bottom");

	if (navigationId === null) {
		navigationId = uniqueId("navigation", itemIds);
		itemIds.add(navigationId);
		items.push(navigationItem(navigationId));
	}

	const seenOwnership = new Set<string>();
	for (const group of groups) {
		group.itemIds = group.itemIds.filter((itemId) => {
			if (!itemIds.has(itemId) || seenOwnership.has(itemId)) {
				return false;
			}
			seenOwnership.add(itemId);
			return true;
		});
	}

	if (!seenOwnership.has(navigationId)) {
		leftGroup.itemIds.unshift(navigationId);
		seenOwnership.add(navigationId);
	}

	let centerGroups = groups.filter((group) => group.region === "center");
	if (centerGroups.length === 0) {
		const id = uniqueId("center-main", groupIds);
		groupIds.add(id);
		const centerGroup: WorkbenchGroup = {
			activeItemId: null,
			id,
			itemIds: [],
			locked: false,
			region: "center",
		};
		groups.push(centerGroup);
		centerGroups = [centerGroup];
	}

	const centerGroupIds = new Set(centerGroups.map((group) => group.id));
	const fallbackCenterGroupId = centerGroups[0]?.id ?? "center-main";
	const normalizedTree =
		removeDuplicateCenterLeaves(
			normalizeCenterTree(
				state.centerTree,
				centerGroupIds,
				fallbackCenterGroupId
			)
		) ?? centerLeaf(fallbackCenterGroupId);
	const treeGroupIds = new Set(centerGroupIdsFromTree(normalizedTree));
	const centerTree = appendCenterGroups(
		normalizedTree,
		centerGroups.filter((group) => !treeGroupIds.has(group.id))
	);

	// Every live item must be owned by exactly one group. An item that lost its
	// group (for example, opened into a group id that no longer exists) returns
	// to its preferred region instead of lingering invisibly in `items`.
	const firstCenterGroupId = centerGroupIdsFromTree(centerTree)[0];
	for (const item of items) {
		if (seenOwnership.has(item.id)) {
			continue;
		}
		const home =
			item.preferredRegion === "center"
				? groups.find((group) => group.id === firstCenterGroupId)
				: groups.find((group) => group.region === item.preferredRegion);
		home?.itemIds.push(item.id);
		seenOwnership.add(item.id);
	}

	// Pinned tabs stay ahead of unpinned tabs within their group.
	const pinnedItemIds = new Set(
		items.filter((item) => item.pinned).map((item) => item.id)
	);
	for (const group of groups) {
		group.itemIds = [
			...group.itemIds.filter((itemId) => pinnedItemIds.has(itemId)),
			...group.itemIds.filter((itemId) => !pinnedItemIds.has(itemId)),
		];
		group.activeItemId = group.itemIds.includes(group.activeItemId ?? "")
			? group.activeItemId
			: (group.itemIds[0] ?? null);
	}

	const focusedGroup = groups.find(
		(group) => group.id === state.focusedGroupId
	);
	const focusedGroupIsVisible =
		focusedGroup?.region === "center" ||
		(focusedGroup !== undefined &&
			focusedGroup.itemIds.length > 0 &&
			state.openRegions[focusedGroup.region]);
	const focusedGroupId = focusedGroupIsVisible
		? state.focusedGroupId
		: fallbackCenterGroupId;

	return {
		bottomAlignment: state.bottomAlignment,
		centerTree,
		closedItems: state.closedItems
			.slice(-MAX_CLOSED_ITEMS)
			.map(({ groupId, index, item }) => ({
				groupId,
				index: Math.max(0, index),
				item: cloneItem(item),
			})),
		focusedGroupId,
		groups,
		items,
		openRegions: { ...state.openRegions, center: true },
		sizes: {
			bottom: clampSize(
				state.sizes.bottom,
				DEFAULT_SIZES.bottom,
				WORKBENCH_SIZE_BOUNDS.bottom.minimum,
				WORKBENCH_SIZE_BOUNDS.bottom.maximum
			),
			left: clampSize(
				state.sizes.left,
				DEFAULT_SIZES.left,
				WORKBENCH_SIZE_BOUNDS.left.minimum,
				WORKBENCH_SIZE_BOUNDS.left.maximum
			),
			right: clampSize(
				state.sizes.right,
				DEFAULT_SIZES.right,
				WORKBENCH_SIZE_BOUNDS.right.minimum,
				WORKBENCH_SIZE_BOUNDS.right.maximum
			),
		},
		version: 2,
	};
}

export function groupForItem(
	state: WorkbenchState,
	itemId: string
): WorkbenchGroup | undefined {
	return state.groups.find((group) => group.itemIds.includes(itemId));
}

export function activeItemForGroup(
	state: WorkbenchState,
	groupId: string
): WorkbenchItem | undefined {
	const group = state.groups.find((candidate) => candidate.id === groupId);
	if (!group?.activeItemId) {
		return undefined;
	}
	return state.items.find((item) => item.id === group.activeItemId);
}

export function visibleItemsForScope(
	state: WorkbenchState,
	scope: WorkbenchScope
): WorkbenchItem[] {
	return state.items.filter((item) => {
		if (item.scope.kind === "window") {
			return true;
		}
		if (item.scope.kind !== scope.kind) {
			return false;
		}
		if (scope.kind === "project") {
			return (
				item.scope.kind === "project" && item.scope.folder === scope.folder
			);
		}
		return (
			item.scope.kind === "conversation" &&
			item.scope.conversationId === scope.conversationId
		);
	});
}
