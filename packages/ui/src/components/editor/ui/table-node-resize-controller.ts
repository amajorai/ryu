// The table's pointer and keyboard resize state machine: tracks one drag at a
// time, previews it through live size overrides (or a single boundary line on
// very large tables), and commits the final sizes when the pointer lifts.

import { resizeLengthClampStatic } from "@platejs/resizable";
import {
	roundCellSizeToStep,
	TablePlugin,
	useOverrideColSize,
	useOverrideMarginLeft,
	useOverrideRowSize,
	useTableColSizes,
} from "@platejs/table/react";
import { useEditorPlugin } from "platejs/react";
import {
	type PointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";

import {
	TABLE_DEFAULT_COLUMN_WIDTH,
	type TableResizeContextValue,
	type TableResizeDragState,
	type TableResizeStartOptions,
} from "./table-node-resize-context.ts";
import {
	useFrozenRowHeights,
	useTableResizeCommits,
	useTableResizeIndicators,
} from "./table-node-resize-helpers.ts";
import {
	getTableInlineSign,
	type TableInlineSign,
	toInlineResizeDelta,
} from "./table-node-resize-rtl.ts";

export function useTableResizeController({
	deferColumnResize,
	dragIndicatorRef,
	hoverIndicatorRef,
	marginLeft,
	controlColumnWidth,
	tablePath,
	tableRef,
	wrapperRef,
}: {
	deferColumnResize: boolean;
	dragIndicatorRef: RefObject<HTMLDivElement | null>;
	hoverIndicatorRef: RefObject<HTMLDivElement | null>;
	marginLeft: number;
	controlColumnWidth: number;
	tablePath: number[];
	tableRef: RefObject<HTMLTableElement | null>;
	wrapperRef: RefObject<HTMLDivElement | null>;
}): TableResizeContextValue {
	const { getOptions } = useEditorPlugin(TablePlugin);
	const { disableMarginLeft = false, minColumnWidth = 0 } = getOptions();
	const colSizes = useTableColSizes({
		disableOverrides: true,
	});
	const effectiveColSizes = useMemo(
		() => colSizes.map((colSize) => colSize || TABLE_DEFAULT_COLUMN_WIDTH),
		[colSizes]
	);
	const effectiveColSizesRef = useRef(effectiveColSizes);
	const activeHandleKeyRef = useRef<string | null>(null);
	const activeRowElementRef = useRef<HTMLTableRowElement | null>(null);
	const cleanupListenersRef = useRef<(() => void) | null>(null);
	const marginLeftRef = useRef(marginLeft);
	const dragStateRef = useRef<TableResizeDragState | null>(null);
	// Direction of the table's inline axis, read when a resize starts.
	const inlineSignRef = useRef<TableInlineSign>(1);
	const previewHandleKeyRef = useRef<string | null>(null);
	const overrideColSize = useOverrideColSize();
	const overrideMarginLeft = useOverrideMarginLeft();
	const overrideRowSize = useOverrideRowSize();

	useEffect(() => {
		effectiveColSizesRef.current = effectiveColSizes;
	}, [effectiveColSizes]);

	useEffect(() => {
		marginLeftRef.current = marginLeft;
	}, [marginLeft]);

	const {
		hideDeferredResizeIndicator,
		hideResizeIndicator,
		showDeferredResizeIndicator,
		showResizeIndicator,
		showResizeIndicatorAtOffset,
	} = useTableResizeIndicators({
		dragIndicatorRef,
		hoverIndicatorRef,
		wrapperRef,
	});
	const { clearFrozenRowHeights, freezeRowHeights } = useFrozenRowHeights({
		deferColumnResize,
		tableRef,
	});
	const { commitColSize, commitMarginLeft, commitRowSize } =
		useTableResizeCommits(tablePath);

	const setResizePreview = useCallback(
		(event: PointerEvent<HTMLDivElement>, options: TableResizeStartOptions) => {
			if (activeHandleKeyRef.current) {
				return;
			}

			previewHandleKeyRef.current = options.handleKey;
			showResizeIndicator({ ...options, event });
		},
		[showResizeIndicator]
	);

	const clearResizePreview = useCallback(
		(handleKey: string) => {
			if (activeHandleKeyRef.current) {
				return;
			}
			if (previewHandleKeyRef.current !== handleKey) {
				return;
			}

			previewHandleKeyRef.current = null;
			hideResizeIndicator();
		},
		[hideResizeIndicator]
	);

	const getColumnBoundaryOffset = useCallback(
		(colIndex: number, currentWidth: number) =>
			controlColumnWidth +
			effectiveColSizesRef.current
				.slice(0, colIndex)
				.reduce((total, colSize) => total + colSize, 0) +
			currentWidth,
		[controlColumnWidth]
	);

	const applyResize = useCallback(
		(
			event: Pick<globalThis.PointerEvent, "clientX" | "clientY">,
			finished: boolean
		) => {
			const dragState = dragStateRef.current;

			if (!dragState) {
				return;
			}

			const currentPosition =
				dragState.direction === "bottom" ? event.clientY : event.clientX;
			const delta = toInlineResizeDelta(
				currentPosition - dragState.initialPosition,
				dragState.direction,
				inlineSignRef.current
			);

			if (dragState.direction === "bottom") {
				const newHeight = roundCellSizeToStep(
					dragState.initialSize + delta,
					undefined
				);

				if (finished) {
					commitRowSize(dragState.rowIndex, newHeight);
				} else {
					overrideRowSize(dragState.rowIndex, newHeight);
				}

				return;
			}

			if (dragState.direction === "left") {
				const initial =
					effectiveColSizesRef.current[dragState.colIndex] ??
					dragState.initialSize;
				const complement = (width: number) =>
					initial + dragState.marginLeft - width;
				const nextMarginLeft = roundCellSizeToStep(
					resizeLengthClampStatic(dragState.marginLeft + delta, {
						max: complement(minColumnWidth),
						min: 0,
					}),
					undefined
				);
				const nextWidth = complement(nextMarginLeft);

				if (finished) {
					commitMarginLeft(nextMarginLeft);
					commitColSize(dragState.colIndex, nextWidth);
				} else if (deferColumnResize) {
					showDeferredResizeIndicator(
						controlColumnWidth + (nextMarginLeft - dragState.marginLeft)
					);
				} else {
					showResizeIndicatorAtOffset(
						controlColumnWidth + (nextMarginLeft - dragState.marginLeft)
					);
					overrideMarginLeft(nextMarginLeft);
					overrideColSize(dragState.colIndex, nextWidth);
				}

				return;
			}

			const currentInitial =
				effectiveColSizesRef.current[dragState.colIndex] ??
				dragState.initialSize;
			const nextInitial = effectiveColSizesRef.current[dragState.colIndex + 1];
			const complement = (width: number) =>
				currentInitial + (nextInitial ?? 0) - width;
			const currentWidth = roundCellSizeToStep(
				resizeLengthClampStatic(currentInitial + delta, {
					max: nextInitial ? complement(minColumnWidth) : undefined,
					min: minColumnWidth,
				}),
				undefined
			);
			const nextWidth = nextInitial ? complement(currentWidth) : undefined;

			if (finished) {
				commitColSize(dragState.colIndex, currentWidth);

				if (nextWidth !== undefined) {
					commitColSize(dragState.colIndex + 1, nextWidth);
				}
			} else if (deferColumnResize) {
				showDeferredResizeIndicator(
					getColumnBoundaryOffset(dragState.colIndex, currentWidth)
				);
			} else {
				showResizeIndicatorAtOffset(
					getColumnBoundaryOffset(dragState.colIndex, currentWidth)
				);
				overrideColSize(dragState.colIndex, currentWidth);

				if (nextWidth !== undefined) {
					overrideColSize(dragState.colIndex + 1, nextWidth);
				}
			}
		},
		[
			commitColSize,
			commitMarginLeft,
			commitRowSize,
			controlColumnWidth,
			deferColumnResize,
			getColumnBoundaryOffset,
			showDeferredResizeIndicator,
			showResizeIndicatorAtOffset,
			minColumnWidth,
			overrideColSize,
			overrideMarginLeft,
			overrideRowSize,
		]
	);

	const stopResize = useCallback(() => {
		cleanupListenersRef.current?.();
		cleanupListenersRef.current = null;
		activeHandleKeyRef.current = null;
		previewHandleKeyRef.current = null;
		dragStateRef.current = null;

		if (activeRowElementRef.current) {
			delete activeRowElementRef.current.dataset.tableResizing;
			activeRowElementRef.current = null;
		}

		hideDeferredResizeIndicator();
		hideResizeIndicator();
		clearFrozenRowHeights();
	}, [clearFrozenRowHeights, hideDeferredResizeIndicator, hideResizeIndicator]);

	useEffect(() => stopResize, [stopResize]);

	const startResize = useCallback(
		(
			event: PointerEvent<HTMLDivElement>,
			{ colIndex, direction, handleKey, rowIndex }: TableResizeStartOptions
		) => {
			const rowHeight =
				tableRef.current?.rows.item(rowIndex)?.getBoundingClientRect().height ??
				0;

			inlineSignRef.current = getTableInlineSign(tableRef.current);
			dragStateRef.current = {
				colIndex,
				direction,
				initialPosition: direction === "bottom" ? event.clientY : event.clientX,
				initialSize:
					direction === "bottom"
						? rowHeight
						: (effectiveColSizesRef.current[colIndex] ??
							TABLE_DEFAULT_COLUMN_WIDTH),
				marginLeft: marginLeftRef.current,
				rowIndex,
			};
			activeHandleKeyRef.current = handleKey;
			previewHandleKeyRef.current = null;

			const rowElement = tableRef.current?.rows.item(rowIndex) ?? null;

			if (
				activeRowElementRef.current &&
				activeRowElementRef.current !== rowElement
			) {
				delete activeRowElementRef.current.dataset.tableResizing;
			}

			activeRowElementRef.current = rowElement;

			if (rowElement) {
				rowElement.dataset.tableResizing = "true";
			}

			cleanupListenersRef.current?.();

			if (direction !== "bottom") {
				freezeRowHeights();
			}

			const handlePointerMove = (pointerEvent: globalThis.PointerEvent) => {
				applyResize(pointerEvent, false);
			};

			const handlePointerEnd = (pointerEvent: globalThis.PointerEvent) => {
				applyResize(pointerEvent, true);
				stopResize();
			};

			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerEnd);
			window.addEventListener("pointercancel", handlePointerEnd);

			cleanupListenersRef.current = () => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerEnd);
				window.removeEventListener("pointercancel", handlePointerEnd);
			};

			if (deferColumnResize && direction !== "bottom") {
				hideResizeIndicator();
				showDeferredResizeIndicator(
					direction === "left"
						? controlColumnWidth
						: getColumnBoundaryOffset(
								colIndex,
								effectiveColSizesRef.current[colIndex] ??
									TABLE_DEFAULT_COLUMN_WIDTH
							)
				);
			} else {
				showResizeIndicator({ direction, event });
			}

			event.preventDefault();
			event.stopPropagation();
		},
		[
			controlColumnWidth,
			deferColumnResize,
			getColumnBoundaryOffset,
			hideResizeIndicator,
			showDeferredResizeIndicator,
			showResizeIndicator,
			stopResize,
			tableRef,
			applyResize,
			freezeRowHeights,
		]
	);

	// Keyboard alternative to the drag (WCAG 2.1.1 / 2.5.7): runs the same
	// resize math as a pointer drag of `delta` pixels and commits immediately.
	const resizeBy = useCallback(
		(
			{ colIndex, direction, rowIndex }: TableResizeStartOptions,
			delta: number
		) => {
			if (dragStateRef.current) {
				return;
			}

			const rowHeight =
				tableRef.current?.rows.item(rowIndex)?.getBoundingClientRect().height ??
				0;

			// Arrow keys are physical: under RTL ArrowLeft moves the inline-end
			// edge outward, so applyResize flips the sign like a pointer drag.
			inlineSignRef.current = getTableInlineSign(tableRef.current);
			dragStateRef.current = {
				colIndex,
				direction,
				initialPosition: 0,
				initialSize:
					direction === "bottom"
						? rowHeight
						: (effectiveColSizesRef.current[colIndex] ??
							TABLE_DEFAULT_COLUMN_WIDTH),
				marginLeft: marginLeftRef.current,
				rowIndex,
			};
			applyResize({ clientX: delta, clientY: delta }, true);
			dragStateRef.current = null;
		},
		[applyResize, tableRef]
	);

	return useMemo(
		() => ({
			clearResizePreview,
			colSizes: effectiveColSizes,
			disableMarginLeft,
			marginLeft,
			minColumnWidth,
			resizeBy,
			setResizePreview,
			startResize,
		}),
		[
			clearResizePreview,
			disableMarginLeft,
			effectiveColSizes,
			marginLeft,
			minColumnWidth,
			resizeBy,
			setResizePreview,
			startResize,
		]
	);
}
