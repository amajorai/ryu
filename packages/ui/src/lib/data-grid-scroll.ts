// Keyboard scroll direction and scrolling a cell into view, for the data grid.
// Split from `data-grid.ts`, which re-exports both.

import type { Table } from "@tanstack/react-table";
import type * as React from "react";

export function getScrollDirection(
	direction: string
): "left" | "right" | "home" | "end" | undefined {
	if (
		direction === "left" ||
		direction === "right" ||
		direction === "home" ||
		direction === "end"
	) {
		return direction;
	}
	if (direction === "pageleft" || direction === "ctrl+left") {
		return "left";
	}
	if (direction === "pageright" || direction === "ctrl+right") {
		return "right";
	}
	return undefined;
}

export function scrollCellIntoView<TData>(params: {
	container: HTMLDivElement;
	targetCell: HTMLDivElement;
	tableRef: React.RefObject<Table<TData> | null>;
	viewportOffset: number;
	direction?: "left" | "right" | "home" | "end";
	isRtl: boolean;
}): void {
	const { container, targetCell, tableRef, direction, viewportOffset, isRtl } =
		params;

	const containerRect = container.getBoundingClientRect();
	const cellRect = targetCell.getBoundingClientRect();

	const hasNegativeScroll = container.scrollLeft < 0;
	const isActuallyRtl = isRtl || hasNegativeScroll;

	const currentTable = tableRef.current;
	const leftPinnedColumns = currentTable?.getLeftVisibleLeafColumns() ?? [];
	const rightPinnedColumns = currentTable?.getRightVisibleLeafColumns() ?? [];

	const leftPinnedWidth = leftPinnedColumns.reduce(
		(sum, c) => sum + c.getSize(),
		0
	);
	const rightPinnedWidth = rightPinnedColumns.reduce(
		(sum, c) => sum + c.getSize(),
		0
	);

	const viewportLeft = isActuallyRtl
		? containerRect.left + rightPinnedWidth + viewportOffset
		: containerRect.left + leftPinnedWidth + viewportOffset;
	const viewportRight = isActuallyRtl
		? containerRect.right - leftPinnedWidth - viewportOffset
		: containerRect.right - rightPinnedWidth - viewportOffset;

	const isFullyVisible =
		cellRect.left >= viewportLeft && cellRect.right <= viewportRight;

	if (isFullyVisible) {
		return;
	}

	const isClippedLeft = cellRect.left < viewportLeft;
	const isClippedRight = cellRect.right > viewportRight;

	let scrollDelta = 0;

	if (direction) {
		const shouldScrollRight = isActuallyRtl
			? direction === "right" || direction === "home"
			: direction === "right" || direction === "end";

		if (shouldScrollRight) {
			scrollDelta = cellRect.right - viewportRight;
		} else {
			scrollDelta = -(viewportLeft - cellRect.left);
		}
	} else if (isClippedRight) {
		scrollDelta = cellRect.right - viewportRight;
	} else if (isClippedLeft) {
		scrollDelta = -(viewportLeft - cellRect.left);
	}

	container.scrollLeft += scrollDelta;
}
