import {
	type BottomAlignment,
	createDefaultWorkbench,
	normalizeWorkbench,
	type WorkbenchGroup,
	type WorkbenchItem,
	type WorkbenchRegion,
	type WorkbenchSplitNode,
	type WorkbenchState,
} from "./model.ts";

export type WorkbenchAction =
	| {
			type: "item/open";
			/** Open without focusing it (default true). */
			activate?: boolean;
			groupId: string;
			item: WorkbenchItem;
			index?: number;
	  }
	| { type: "item/update"; item: WorkbenchItem }
	| {
			type: "item/move";
			activate?: boolean;
			itemId: string;
			toGroupId: string;
			index?: number;
	  }
	| { type: "item/activate"; itemId: string }
	| { type: "item/close"; itemId: string }
	| { type: "item/restore"; itemId: string }
	| { type: "item/reorder"; groupId: string; itemId: string; toIndex: number }
	| { type: "item/pin"; itemId: string; pinned?: boolean }
	| { type: "group/focus"; groupId: string }
	| { type: "region/show"; region: WorkbenchRegion }
	| { type: "region/hide"; region: Exclude<WorkbenchRegion, "center"> }
	| {
			type: "region/resize";
			region: Exclude<WorkbenchRegion, "center">;
			size: number;
	  }
	| { type: "bottom/align"; alignment: BottomAlignment }
	| {
			type: "center/split";
			direction: "down" | "left" | "right" | "up";
			newGroupId: string;
			targetGroupId: string;
	  }
	| { type: "center/remove-group"; groupId: string }
	| { type: "center/replace-tree"; tree: WorkbenchSplitNode }
	| { type: "center/resize-branch"; path: number[]; sizes: number[] }
	| { type: "layout/reset" };

function copyState(state: WorkbenchState): WorkbenchState {
	return {
		...state,
		centerTree: copyTree(state.centerTree),
		closedItems: state.closedItems.map((closed) => ({
			...closed,
			item: {
				...closed.item,
				scope: { ...closed.item.scope },
				source: { ...closed.item.source },
			},
		})),
		groups: state.groups.map((group) => ({
			...group,
			itemIds: [...group.itemIds],
		})),
		items: state.items.map((item) => ({
			...item,
			scope: { ...item.scope },
			source: { ...item.source },
		})),
		openRegions: { ...state.openRegions },
		sizes: { ...state.sizes },
	};
}

function copyTree(tree: WorkbenchSplitNode): WorkbenchSplitNode {
	if (tree.type === "leaf") {
		return { ...tree };
	}
	return {
		...tree,
		children: tree.children.map(copyTree),
		sizes: [...tree.sizes],
	};
}

function clampIndex(index: number | undefined, length: number): number {
	if (index === undefined || !Number.isFinite(index)) {
		return length;
	}
	return Math.min(length, Math.max(0, Math.trunc(index)));
}

function insertItemId(
	itemIds: string[],
	itemId: string,
	index?: number
): string[] {
	const withoutItem = itemIds.filter((candidate) => candidate !== itemId);
	const insertionIndex = clampIndex(index, withoutItem.length);
	return [
		...withoutItem.slice(0, insertionIndex),
		itemId,
		...withoutItem.slice(insertionIndex),
	];
}

function groupForRegion(
	state: WorkbenchState,
	region: WorkbenchRegion
): WorkbenchGroup | undefined {
	return state.groups.find((group) => group.region === region);
}

/**
 * Remove an item from a group. When it was the active tab, its neighbor takes
 * over (the tab that slides into its position, else the one before it), like an
 * editor tab strip, instead of jumping to the first tab.
 */
function withoutItem(group: WorkbenchGroup, itemId: string): WorkbenchGroup {
	const removedIndex = group.itemIds.indexOf(itemId);
	if (removedIndex === -1) {
		return group;
	}
	const itemIds = group.itemIds.filter((candidate) => candidate !== itemId);
	return {
		...group,
		activeItemId:
			group.activeItemId === itemId
				? (itemIds[Math.min(removedIndex, itemIds.length - 1)] ?? null)
				: group.activeItemId,
		itemIds,
	};
}

/** Activating something in a hidden surrounding region shows that region. */
function revealGroupRegion(
	state: WorkbenchState,
	groupId: string
): WorkbenchState {
	const region = state.groups.find((group) => group.id === groupId)?.region;
	if (!region || region === "center" || state.openRegions[region]) {
		return state;
	}
	return { ...state, openRegions: { ...state.openRegions, [region]: true } };
}

function moveItem(
	state: WorkbenchState,
	itemId: string,
	toGroupId: string,
	index?: number,
	activate = true
): WorkbenchState {
	const targetGroup = state.groups.find((group) => group.id === toGroupId);
	if (!(targetGroup && state.items.some((item) => item.id === itemId))) {
		return state;
	}

	const moved: WorkbenchState = {
		...state,
		focusedGroupId: activate ? toGroupId : state.focusedGroupId,
		groups: state.groups.map((group) => {
			if (group.id === toGroupId) {
				const itemIds = insertItemId(group.itemIds, itemId, index);
				return {
					...group,
					activeItemId: activate ? itemId : group.activeItemId,
					itemIds,
				};
			}
			return withoutItem(group, itemId);
		}),
	};
	return activate ? revealGroupRegion(moved, toGroupId) : moved;
}

function splitCenterTree(
	tree: WorkbenchSplitNode,
	targetGroupId: string,
	newGroupId: string,
	direction: "down" | "left" | "right" | "up"
): WorkbenchSplitNode {
	if (tree.type === "leaf") {
		if (tree.groupId !== targetGroupId) {
			return tree;
		}
		const newLeaf: WorkbenchSplitNode = { type: "leaf", groupId: newGroupId };
		const targetLeaf: WorkbenchSplitNode = {
			type: "leaf",
			groupId: targetGroupId,
		};
		const isBefore = direction === "left" || direction === "up";
		return {
			type: "branch",
			orientation:
				direction === "left" || direction === "right" ? "columns" : "rows",
			children: isBefore ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
			sizes: [0.5, 0.5],
		};
	}

	return {
		...tree,
		children: tree.children.map((child) =>
			splitCenterTree(child, targetGroupId, newGroupId, direction)
		),
	};
}

function removeCenterLeaf(
	tree: WorkbenchSplitNode,
	groupId: string
): WorkbenchSplitNode | null {
	if (tree.type === "leaf") {
		return tree.groupId === groupId ? null : tree;
	}

	const children: WorkbenchSplitNode[] = [];
	const sizes: number[] = [];
	// A removed pane's share goes to the neighbor before it, or to the one after
	// it when it was first, so the remaining panes keep their proportions.
	let carriedSize = 0;
	for (const [index, child] of tree.children.entries()) {
		const remaining = removeCenterLeaf(child, groupId);
		const size = tree.sizes[index] ?? 0;
		if (!remaining) {
			if (sizes.length > 0) {
				sizes[sizes.length - 1] = (sizes.at(-1) ?? 0) + size;
			} else {
				carriedSize += size;
			}
			continue;
		}
		children.push(remaining);
		sizes.push(size + carriedSize);
		carriedSize = 0;
	}
	if (children.length === 0) {
		return null;
	}
	if (children.length === 1) {
		return children[0] ?? null;
	}
	return { ...tree, children, sizes };
}

function centerLeafOrder(tree: WorkbenchSplitNode): string[] {
	return tree.type === "leaf"
		? [tree.groupId]
		: tree.children.flatMap(centerLeafOrder);
}

function resizeCenterBranch(
	tree: WorkbenchSplitNode,
	path: number[],
	sizes: number[]
): WorkbenchSplitNode {
	if (path.length === 0) {
		return tree.type === "branch" ? { ...tree, sizes: [...sizes] } : tree;
	}
	if (tree.type === "leaf") {
		return tree;
	}

	const [index, ...remainingPath] = path;
	if (index === undefined || index < 0 || index >= tree.children.length) {
		return tree;
	}
	return {
		...tree,
		children: tree.children.map((child, childIndex) =>
			childIndex === index
				? resizeCenterBranch(child, remainingPath, sizes)
				: child
		),
	};
}

/**
 * Reset placement and geometry to the default four-region layout. Items are
 * kept (closing nothing), but each returns to its preferred region, so a
 * moved Navigation tab is always recoverable and Center collapses to one
 * group. The focused Center tab stays active.
 */
function resetLayout(state: WorkbenchState): WorkbenchState {
	const leftGroup = groupForRegion(state, "left");
	const rightGroup = groupForRegion(state, "right");
	const bottomGroup = groupForRegion(state, "bottom");
	const centerOrder = centerLeafOrder(state.centerTree);
	const focusedGroup = state.groups.find(
		(group) => group.id === state.focusedGroupId
	);
	const centerGroupId =
		focusedGroup?.region === "center" ? focusedGroup.id : centerOrder[0];

	if (!(leftGroup && rightGroup && bottomGroup && centerGroupId)) {
		return state;
	}

	const reset = createDefaultWorkbench({
		bottomGroupId: bottomGroup.id,
		centerGroupId,
		leftGroupId: leftGroup.id,
		navigationId:
			state.items.find((item) => item.source.kind === "navigation")?.id ??
			"navigation",
		rightGroupId: rightGroup.id,
	});
	const groupsById = new Map(state.groups.map((group) => [group.id, group]));
	const orderedGroups = [
		leftGroup,
		...centerOrder.flatMap((id) => {
			const group = groupsById.get(id);
			return group ? [group] : [];
		}),
		rightGroup,
		bottomGroup,
	];
	const itemsById = new Map(state.items.map((item) => [item.id, item]));
	const itemIdsByRegion: Record<WorkbenchRegion, string[]> = {
		bottom: [],
		center: [],
		left: [],
		right: [],
	};
	for (const group of orderedGroups) {
		for (const itemId of group.itemIds) {
			const item = itemsById.get(itemId);
			if (item) {
				itemIdsByRegion[item.preferredRegion].push(itemId);
			}
		}
	}
	// The focused group's active tab wins, then other groups' active tabs.
	const previouslyActive = [
		activeItemIdForGroup(focusedGroup),
		...orderedGroups.map(activeItemIdForGroup),
	].filter((itemId): itemId is string => itemId !== null);
	return {
		...reset,
		closedItems: state.closedItems,
		groups: reset.groups.map((group) => {
			const itemIds = itemIdsByRegion[group.region];
			return {
				...group,
				activeItemId:
					previouslyActive.find((itemId) => itemIds.includes(itemId)) ??
					itemIds[0] ??
					null,
				itemIds,
			};
		}),
		items: state.items,
	};
}

function activeItemIdForGroup(
	group: WorkbenchGroup | undefined
): string | null {
	return group?.activeItemId ?? null;
}

function findLastClosedItemIndex(
	state: WorkbenchState,
	itemId: string
): number {
	for (let index = state.closedItems.length - 1; index >= 0; index -= 1) {
		if (state.closedItems[index]?.item.id === itemId) {
			return index;
		}
	}
	return -1;
}

export function reduceWorkbench(
	state: WorkbenchState,
	action: WorkbenchAction
): WorkbenchState {
	const current = normalizeWorkbench(state);
	let next = copyState(current);

	switch (action.type) {
		case "item/open": {
			const existingItem = next.items.find(
				(item) => item.id === action.item.id
			);
			if (!existingItem) {
				next.items.push({
					...action.item,
					scope: { ...action.item.scope },
					source: { ...action.item.source },
				});
			}
			next = moveItem(
				next,
				action.item.id,
				action.groupId,
				action.index,
				action.activate ?? true
			);
			break;
		}
		case "item/update":
			if (next.items.some((item) => item.id === action.item.id)) {
				next.items = next.items.map((item) =>
					item.id === action.item.id
						? {
								...action.item,
								scope: { ...action.item.scope },
								source: { ...action.item.source },
							}
						: item
				);
			}
			break;
		case "item/move":
			next = moveItem(
				next,
				action.itemId,
				action.toGroupId,
				action.index,
				action.activate
			);
			break;
		case "item/activate": {
			const group = next.groups.find((candidate) =>
				candidate.itemIds.includes(action.itemId)
			);
			if (group) {
				next.focusedGroupId = group.id;
				next.groups = next.groups.map((candidate) =>
					candidate.id === group.id
						? { ...candidate, activeItemId: action.itemId }
						: candidate
				);
				next = revealGroupRegion(next, group.id);
			}
			break;
		}
		case "item/close": {
			const item = next.items.find(
				(candidate) => candidate.id === action.itemId
			);
			const group = next.groups.find((candidate) =>
				candidate.itemIds.includes(action.itemId)
			);
			if (item?.closable && group) {
				const index = group.itemIds.indexOf(action.itemId);
				next.closedItems.push({ groupId: group.id, index, item });
				next.items = next.items.filter(
					(candidate) => candidate.id !== action.itemId
				);
				next.groups = next.groups.map((candidate) =>
					candidate.id === group.id
						? withoutItem(candidate, action.itemId)
						: candidate
				);
			}
			break;
		}
		case "item/restore": {
			const closedIndex = findLastClosedItemIndex(next, action.itemId);
			const closed = next.closedItems[closedIndex];
			if (closed) {
				const target =
					next.groups.find((group) => group.id === closed.groupId) ??
					groupForRegion(next, closed.item.preferredRegion);
				if (target && !next.items.some((item) => item.id === closed.item.id)) {
					next.items.push(closed.item);
					next.closedItems.splice(closedIndex, 1);
					next = moveItem(next, closed.item.id, target.id, closed.index);
				}
			}
			break;
		}
		case "item/reorder": {
			const group = next.groups.find(
				(candidate) => candidate.id === action.groupId
			);
			if (group?.itemIds.includes(action.itemId)) {
				next.groups = next.groups.map((candidate) =>
					candidate.id === action.groupId
						? {
								...candidate,
								itemIds: insertItemId(
									candidate.itemIds,
									action.itemId,
									action.toIndex
								),
							}
						: candidate
				);
			}
			break;
		}
		case "item/pin":
			next.items = next.items.map((item) =>
				item.id === action.itemId
					? { ...item, pinned: action.pinned ?? !item.pinned }
					: item
			);
			break;
		case "group/focus":
			if (next.groups.some((group) => group.id === action.groupId)) {
				next.focusedGroupId = action.groupId;
			}
			break;
		case "region/show":
			next.openRegions[action.region] = true;
			break;
		case "region/hide":
			next.openRegions[action.region] = false;
			break;
		case "region/resize":
			next.sizes[action.region] = action.size;
			break;
		case "bottom/align":
			next.bottomAlignment = action.alignment;
			break;
		case "center/split": {
			const target = next.groups.find(
				(group) =>
					group.id === action.targetGroupId && group.region === "center"
			);
			const alreadyExists = next.groups.some(
				(group) => group.id === action.newGroupId
			);
			if (target && !alreadyExists) {
				next.groups.push({
					activeItemId: null,
					id: action.newGroupId,
					itemIds: [],
					locked: false,
					region: "center",
				});
				next.centerTree = splitCenterTree(
					next.centerTree,
					action.targetGroupId,
					action.newGroupId,
					action.direction
				);
			}
			break;
		}
		case "center/remove-group": {
			const group = next.groups.find(
				(candidate) =>
					candidate.id === action.groupId && candidate.region === "center"
			);
			// Merge into the adjacent Center group (the one that absorbs the space).
			const leafOrder = centerLeafOrder(next.centerTree);
			const leafIndex = leafOrder.indexOf(action.groupId);
			const neighborId = leafOrder[leafIndex - 1] ?? leafOrder[leafIndex + 1];
			const remainingCenterGroup =
				next.groups.find(
					(candidate) =>
						candidate.id === neighborId && candidate.region === "center"
				) ??
				next.groups.find(
					(candidate) =>
						candidate.region === "center" && candidate.id !== action.groupId
				);
			if (group && remainingCenterGroup) {
				const centerTree = removeCenterLeaf(next.centerTree, group.id);
				if (centerTree) {
					next.groups = next.groups
						.filter((candidate) => candidate.id !== group.id)
						.map((candidate) =>
							candidate.id === remainingCenterGroup.id
								? {
										...candidate,
										itemIds: [...candidate.itemIds, ...group.itemIds],
									}
								: candidate
						);
					next.centerTree = centerTree;
					if (next.focusedGroupId === group.id) {
						next.focusedGroupId = remainingCenterGroup.id;
					}
				}
			}
			break;
		}
		case "center/replace-tree":
			next.centerTree = copyTree(action.tree);
			break;
		case "center/resize-branch":
			next.centerTree = resizeCenterBranch(
				next.centerTree,
				action.path,
				action.sizes
			);
			break;
		case "layout/reset":
			next = resetLayout(next);
			break;
		default:
			return normalizeWorkbench(current);
	}

	return normalizeWorkbench(next);
}
