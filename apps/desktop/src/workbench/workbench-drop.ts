import type { WorkbenchState } from "@ryu/workbench/model";
import type { WorkbenchAction } from "@ryu/workbench/reducer";
import type { SplitDirection } from "@/src/lib/splitTree.ts";

export function makeCenterGroupId(): string {
	return `grp-${crypto.randomUUID()}`;
}

/**
 * Apply a drop on a Center group. Edge zones split the target group and move
 * the dragged item into the new group. The center zone exchanges the active
 * items of two Center groups; a tab dragged from Left, Right, or Bottom moves
 * into the hovered group instead, so nothing is pushed out of Center.
 */
export function applyWorkbenchPaneDrop({
	dispatch,
	draggingId,
	makeGroupId = makeCenterGroupId,
	state,
	synchronizeRoute,
	targetGroupId,
	zone,
}: {
	dispatch: (action: WorkbenchAction) => void;
	draggingId: string;
	makeGroupId?: () => string;
	state: WorkbenchState;
	synchronizeRoute?: (itemId: string) => void;
	targetGroupId: string;
	zone: SplitDirection | "center";
}): void {
	const sourceGroup = state.groups.find((group) =>
		group.itemIds.includes(draggingId)
	);
	const targetGroup = state.groups.find((group) => group.id === targetGroupId);
	if (!(sourceGroup && targetGroup?.region === "center")) {
		return;
	}
	if (zone === "center") {
		if (sourceGroup.id === targetGroup.id) {
			return;
		}
		const targetItemId = targetGroup.activeItemId;
		synchronizeRoute?.(draggingId);
		dispatch({
			type: "item/move",
			itemId: draggingId,
			toGroupId: targetGroup.id,
		});
		if (targetItemId && sourceGroup.region === "center") {
			dispatch({
				type: "item/move",
				itemId: targetItemId,
				toGroupId: sourceGroup.id,
			});
		}
		return;
	}
	synchronizeRoute?.(draggingId);
	const newGroupId = makeGroupId();
	dispatch({
		type: "center/split",
		direction: zone,
		newGroupId,
		targetGroupId,
	});
	dispatch({ type: "item/move", itemId: draggingId, toGroupId: newGroupId });
	dispatch({ type: "item/pin", itemId: draggingId, pinned: false });
	if (
		sourceGroup.region === "center" &&
		sourceGroup.id !== targetGroupId &&
		sourceGroup.itemIds.length === 1
	) {
		dispatch({ type: "center/remove-group", groupId: sourceGroup.id });
	}
}

/**
 * The Center group a split command targets for an item: its own group when it
 * already lives in Center, otherwise the focused (or first) Center group.
 */
export function splitTargetGroupId(
	state: WorkbenchState,
	itemId: string
): string | undefined {
	const ownGroup = state.groups.find((group) => group.itemIds.includes(itemId));
	if (ownGroup?.region === "center") {
		return ownGroup.id;
	}
	const focused = state.groups.find(
		(group) => group.id === state.focusedGroupId && group.region === "center"
	);
	return (
		focused?.id ?? state.groups.find((group) => group.region === "center")?.id
	);
}

/**
 * Insertion index for a drop on a tab strip, counted in the target group's
 * list without the dragged item (which `item/move` removes before inserting).
 * `overItemId` null appends.
 */
export function stripDropIndex(
	itemIds: string[],
	draggedId: string,
	overItemId: string | null,
	before: boolean
): number {
	const withoutDragged = itemIds.filter((itemId) => itemId !== draggedId);
	if (overItemId === null) {
		return withoutDragged.length;
	}
	const overIndex = withoutDragged.indexOf(overItemId);
	if (overIndex === -1) {
		return withoutDragged.length;
	}
	return before ? overIndex : overIndex + 1;
}
