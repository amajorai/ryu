// Building blocks of the table resize controller: the hover/drag boundary
// indicators, the row-height freeze that keeps rows still while a column is
// dragged, and the commits that write the final sizes back to the document.

import {
	setTableColSize,
	setTableMarginLeft,
	setTableRowSize,
} from "@platejs/table";
import {
	TablePlugin,
	useOverrideColSize,
	useOverrideMarginLeft,
	useOverrideRowSize,
} from "@platejs/table/react";
import { useEditorPlugin } from "platejs/react";
import { type PointerEvent, type RefObject, useCallback, useRef } from "react";

import type { TableResizeStartOptions } from "./table-node-resize-context.ts";

function hideIndicator(indicator: HTMLDivElement | null) {
	if (!indicator) {
		return;
	}

	indicator.style.display = "none";
	indicator.style.removeProperty("left");
}

function showIndicator(indicator: HTMLDivElement | null, offset: number) {
	if (!indicator) {
		return;
	}

	indicator.style.display = "block";
	indicator.style.left = `${offset}px`;
}

/** Show and hide the two boundary lines drawn over the table while resizing. */
export function useTableResizeIndicators({
	dragIndicatorRef,
	hoverIndicatorRef,
	wrapperRef,
}: {
	dragIndicatorRef: RefObject<HTMLDivElement | null>;
	hoverIndicatorRef: RefObject<HTMLDivElement | null>;
	wrapperRef: RefObject<HTMLDivElement | null>;
}) {
	const hideDeferredResizeIndicator = useCallback(() => {
		hideIndicator(dragIndicatorRef.current);
	}, [dragIndicatorRef]);

	const showDeferredResizeIndicator = useCallback(
		(offset: number) => {
			showIndicator(dragIndicatorRef.current, offset);
		},
		[dragIndicatorRef]
	);

	const hideResizeIndicator = useCallback(() => {
		hideIndicator(hoverIndicatorRef.current);
	}, [hoverIndicatorRef]);

	const showResizeIndicatorAtOffset = useCallback(
		(offset: number) => {
			showIndicator(hoverIndicatorRef.current, offset);
		},
		[hoverIndicatorRef]
	);

	const showResizeIndicator = useCallback(
		({
			event,
			direction,
		}: Pick<TableResizeStartOptions, "direction"> & {
			event: PointerEvent<HTMLDivElement>;
		}) => {
			if (direction === "bottom") {
				return;
			}

			const wrapper = wrapperRef.current;

			if (!wrapper) {
				return;
			}

			const handleRect = event.currentTarget.getBoundingClientRect();
			const wrapperRect = wrapper.getBoundingClientRect();
			const boundaryOffset =
				handleRect.left - wrapperRect.left + handleRect.width / 2;

			showResizeIndicatorAtOffset(boundaryOffset);
		},
		[showResizeIndicatorAtOffset, wrapperRef]
	);

	return {
		hideDeferredResizeIndicator,
		hideResizeIndicator,
		showDeferredResizeIndicator,
		showResizeIndicator,
		showResizeIndicatorAtOffset,
	};
}

/** Pin every row to its rendered height while a column drag reflows text. */
export function useFrozenRowHeights({
	deferColumnResize,
	tableRef,
}: {
	deferColumnResize: boolean;
	tableRef: RefObject<HTMLTableElement | null>;
}) {
	const frozenRowIndicesRef = useRef<number[] | null>(null);
	const overrideRowSize = useOverrideRowSize();

	const clearFrozenRowHeights = useCallback(() => {
		const frozenRowIndices = frozenRowIndicesRef.current;

		if (!frozenRowIndices) {
			return;
		}

		frozenRowIndicesRef.current = null;

		for (const rowIndex of frozenRowIndices) {
			overrideRowSize(rowIndex, null);
		}
	}, [overrideRowSize]);

	const freezeRowHeights = useCallback(() => {
		const table = tableRef.current;

		if (!table || deferColumnResize) {
			return;
		}

		clearFrozenRowHeights();

		const frozenRowIndices: number[] = [];

		Array.from(table.rows).forEach((row, rowIndex) => {
			const height = row.getBoundingClientRect().height;

			if (!height) {
				return;
			}

			overrideRowSize(rowIndex, height);
			frozenRowIndices.push(rowIndex);
		});

		frozenRowIndicesRef.current = frozenRowIndices;
	}, [clearFrozenRowHeights, deferColumnResize, overrideRowSize, tableRef]);

	return { clearFrozenRowHeights, freezeRowHeights };
}

/** Write a finished resize to the document and drop its live override. */
export function useTableResizeCommits(tablePath: number[]) {
	const { editor } = useEditorPlugin(TablePlugin);
	const overrideColSize = useOverrideColSize();
	const overrideMarginLeft = useOverrideMarginLeft();
	const overrideRowSize = useOverrideRowSize();

	const commitColSize = useCallback(
		(colIndex: number, width: number) => {
			setTableColSize(editor, { colIndex, width }, { at: tablePath });
			setTimeout(() => overrideColSize(colIndex, null), 0);
		},
		[editor, overrideColSize, tablePath]
	);

	const commitRowSize = useCallback(
		(rowIndex: number, height: number) => {
			setTableRowSize(editor, { height, rowIndex }, { at: tablePath });
			setTimeout(() => overrideRowSize(rowIndex, null), 0);
		},
		[editor, overrideRowSize, tablePath]
	);

	const commitMarginLeft = useCallback(
		(nextMarginLeft: number) => {
			setTableMarginLeft(
				editor,
				{ marginLeft: nextMarginLeft },
				{ at: tablePath }
			);
			setTimeout(() => overrideMarginLeft(null), 0);
		},
		[editor, overrideMarginLeft, tablePath]
	);

	return { commitColSize, commitMarginLeft, commitRowSize };
}
