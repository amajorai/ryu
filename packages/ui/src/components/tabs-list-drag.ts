import type { ReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useMemo,
} from "react";
import {
	normalizeOrder,
	reorderKeys,
	TABS_DRAG_MIME,
	type TabsDragController,
} from "./tabs-layout.ts";

interface TabsInlineIndicator {
	height: number;
	left: number;
	top: number;
	width: number;
}

interface TabsDragControllerOptions {
	draggingKey: string | null;
	draggingKeyRef: RefObject<string | null>;
	dropTarget: { before: boolean; key: string } | null;
	itemKeys: string[];
	listRef: RefObject<HTMLDivElement | null>;
	menuShift: ReorderShift;
	orientation: "horizontal" | "vertical";
	setDraggingKey: Dispatch<SetStateAction<string | null>>;
	setDropTarget: Dispatch<
		SetStateAction<{ before: boolean; key: string } | null>
	>;
	setInlineIndicator: Dispatch<SetStateAction<TabsInlineIndicator | null>>;
	setOrder: Dispatch<SetStateAction<string[]>>;
	setPromotedKey: Dispatch<SetStateAction<string | null>>;
	setVisibleKeys: Dispatch<SetStateAction<string[] | null>>;
	triggerShift: ReorderShift;
}

/** Drag-to-reorder state shared by the tab triggers and the layout menu. */
function useTabsDragController({
	draggingKey,
	draggingKeyRef,
	dropTarget,
	itemKeys,
	listRef,
	menuShift,
	orientation,
	setDraggingKey,
	setDropTarget,
	setInlineIndicator,
	setOrder,
	setPromotedKey,
	setVisibleKeys,
	triggerShift,
}: TabsDragControllerOptions) {
	const clearDrag = useCallback(() => {
		draggingKeyRef.current = null;
		setDraggingKey(null);
		setDropTarget(null);
		setInlineIndicator(null);
	}, []);
	const commitReorder = useCallback(
		(sourceKey: string, targetKey: string, before: boolean) => {
			setOrder((current) =>
				reorderKeys(
					normalizeOrder(current, itemKeys),
					sourceKey,
					targetKey,
					before
				)
			);
			setVisibleKeys(null);
			setPromotedKey(null);
		},
		[itemKeys]
	);
	const drag = useMemo<TabsDragController>(
		() => ({
			draggingKey,
			dropTarget,
			menuShift,
			onDragEnd: clearDrag,
			onDragOver: (key, before, element) => {
				const sourceKey = draggingKeyRef.current ?? draggingKey;
				if (!sourceKey) {
					return;
				}
				if (sourceKey === key) {
					// Back over its own resting slot: nothing moves.
					setDropTarget(null);
					setInlineIndicator(null);
					return;
				}
				setDropTarget({ before, key });
				if (!(element && listRef.current)) {
					return;
				}
				const listRect = listRef.current.getBoundingClientRect();
				const rect = element.getBoundingClientRect();
				if (orientation === "vertical") {
					setInlineIndicator({
						height: 2,
						left: rect.left - listRect.left + 4,
						top: (before ? rect.top : rect.bottom) - listRect.top - 1,
						width: Math.max(0, rect.width - 8),
					});
				} else {
					setInlineIndicator({
						height: Math.max(0, rect.height - 8),
						left: (before ? rect.left : rect.right) - listRect.left - 1,
						top: rect.top - listRect.top + 4,
						width: 2,
					});
				}
			},
			onDragStart: (key, event) => {
				draggingKeyRef.current = key;
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(TABS_DRAG_MIME, key);
				event.dataTransfer.setData("text/plain", key);
				setDraggingKey(key);
				setDropTarget(null);
				setInlineIndicator(null);
			},
			onDrop: (key, before, sourceKey) => {
				const source = sourceKey ?? draggingKeyRef.current ?? draggingKey;
				if (source && source !== key) {
					commitReorder(source, key, before);
				}
				clearDrag();
			},
			shift: triggerShift,
		}),
		[
			clearDrag,
			commitReorder,
			draggingKey,
			dropTarget,
			menuShift,
			orientation,
			triggerShift,
		]
	);
	return drag;
}

export { useTabsDragController };
