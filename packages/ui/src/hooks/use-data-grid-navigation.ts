import {
	HORIZONTAL_PAGE_SIZE,
	VIEWPORT_OFFSET,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridPasteContext } from "@ryu/ui/hooks/use-data-grid-paste.ts";
import {
	getCellKey,
	getRowHeightValue,
	getScrollDirection,
	scrollCellIntoView,
} from "@ryu/ui/lib/data-grid.ts";
import { findDataEdge, isCellValueEmpty } from "@ryu/ui/lib/data-grid-fill.ts";
import type {
	CellPosition,
	NavigationDirection,
} from "@ryu/ui/types/data-grid.ts";
import type { Row } from "@tanstack/react-table";
import { useCallback } from "react";

function useDataGridNavigation<TData>(
	gridContext: DataGridPasteContext<TData>
) {
	const {
		cellMapRef,
		dataGridRef,
		dir,
		focusCell,
		footerRef,
		headerRef,
		navigableColumnIds,
		propsRef,
		pushHistory,
		rowHeight,
		rowMapRef,
		rowVirtualizerRef,
		store,
		tableRef,
	} = gridContext;

	const onRowsDelete = useCallback(
		async (rowIndices: number[]) => {
			if (
				propsRef.current.readOnly ||
				!propsRef.current.onRowsDelete ||
				rowIndices.length === 0
			) {
				return;
			}

			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows;

			if (!rows || rows.length === 0) {
				return;
			}

			const currentState = store.getState();
			const currentFocusedColumn =
				currentState.focusedCell?.columnId ?? navigableColumnIds[0];

			const minDeletedRowIndex = Math.min(...rowIndices);

			const deleted: Row<TData>[] = [];
			for (const rowIndex of rowIndices) {
				const row = rows[rowIndex];
				if (row) {
					deleted.push(row);
				}
			}

			// `rowIndices` are visual (sorted/filtered) positions; the consumer gets
			// each row's index in `data`.
			await propsRef.current.onRowsDelete(
				deleted.map((row) => row.original),
				deleted.map((row) => row.index)
			);
			pushHistory({
				kind: "rows-removed",
				rows: deleted.map((row) => ({
					rowId: row.id,
					dataIndex: row.index,
					original: row.original,
				})),
			});

			store.batch(() => {
				store.setState("selectionState", {
					selectedCells: new Set(),
					selectionRange: null,
					isSelecting: false,
				});
				store.setState("rowSelection", {});
				store.setState("editingCell", null);
			});

			requestAnimationFrame(() => {
				const currentTable = tableRef.current;
				const currentRows = currentTable?.getRowModel().rows ?? [];
				const newRowCount = currentRows.length ?? propsRef.current.data.length;

				if (newRowCount > 0 && currentFocusedColumn) {
					const targetRowIndex = Math.min(minDeletedRowIndex, newRowCount - 1);
					focusCell(targetRowIndex, currentFocusedColumn);
				}
			});
		},
		[propsRef, store, navigableColumnIds, focusCell, pushHistory]
	);

	// Excel's Ctrl+Arrow: jump to the edge of the current data block, or to the
	// next filled cell across blanks, along one axis.
	const getDataEdge = useCallback(
		(
			from: CellPosition,
			direction: "up" | "down" | "left" | "right"
		): CellPosition => {
			const rows = tableRef.current?.getRowModel().rows ?? [];

			if (direction === "up" || direction === "down") {
				const rowIndex = findDataEdge({
					isFilled: (index) =>
						!isCellValueEmpty(rows[index]?.getValue(from.columnId)),
					length: rows.length,
					start: from.rowIndex,
					step: direction === "up" ? -1 : 1,
				});
				return { rowIndex, columnId: from.columnId };
			}

			const colIndex = navigableColumnIds.indexOf(from.columnId);
			if (colIndex === -1) {
				return from;
			}
			const row = rows[from.rowIndex];
			const towardEnd = (direction === "right") !== (dir === "rtl");
			const target = findDataEdge({
				isFilled: (index) => {
					const id = navigableColumnIds[index];
					return id ? !isCellValueEmpty(row?.getValue(id)) : false;
				},
				length: navigableColumnIds.length,
				start: colIndex,
				step: towardEnd ? 1 : -1,
			});
			return {
				rowIndex: from.rowIndex,
				columnId: navigableColumnIds[target] ?? from.columnId,
			};
		},
		[dir, navigableColumnIds]
	);

	const navigateCell = useCallback(
		(direction: NavigationDirection) => {
			const currentState = store.getState();
			if (!currentState.focusedCell) {
				return;
			}

			const { rowIndex, columnId } = currentState.focusedCell;
			const currentColIndex = navigableColumnIds.indexOf(columnId);
			const rowVirtualizer = rowVirtualizerRef.current;
			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows ?? [];
			const rowCount = rows.length ?? propsRef.current.data.length;

			let newRowIndex = rowIndex;
			let newColumnId = columnId;

			const isRtl = dir === "rtl";

			switch (direction) {
				case "up":
					newRowIndex = Math.max(0, rowIndex - 1);
					break;
				case "down":
					newRowIndex = Math.min(rowCount - 1, rowIndex + 1);
					break;
				case "left":
					if (isRtl) {
						if (currentColIndex < navigableColumnIds.length - 1) {
							const nextColumnId = navigableColumnIds[currentColIndex + 1];
							if (nextColumnId) {
								newColumnId = nextColumnId;
							}
						}
					} else if (currentColIndex > 0) {
						const prevColumnId = navigableColumnIds[currentColIndex - 1];
						if (prevColumnId) {
							newColumnId = prevColumnId;
						}
					}
					break;
				case "right":
					if (isRtl) {
						if (currentColIndex > 0) {
							const prevColumnId = navigableColumnIds[currentColIndex - 1];
							if (prevColumnId) {
								newColumnId = prevColumnId;
							}
						}
					} else if (currentColIndex < navigableColumnIds.length - 1) {
						const nextColumnId = navigableColumnIds[currentColIndex + 1];
						if (nextColumnId) {
							newColumnId = nextColumnId;
						}
					}
					break;
				case "home":
					if (navigableColumnIds.length > 0) {
						newColumnId = navigableColumnIds[0] ?? columnId;
					}
					break;
				case "end":
					if (navigableColumnIds.length > 0) {
						newColumnId = navigableColumnIds.at(-1) ?? columnId;
					}
					break;
				case "ctrl+home":
					newRowIndex = 0;
					if (navigableColumnIds.length > 0) {
						newColumnId = navigableColumnIds[0] ?? columnId;
					}
					break;
				case "ctrl+end":
					newRowIndex = Math.max(0, rowCount - 1);
					if (navigableColumnIds.length > 0) {
						newColumnId = navigableColumnIds.at(-1) ?? columnId;
					}
					break;
				case "ctrl+up":
					newRowIndex = getDataEdge({ rowIndex, columnId }, "up").rowIndex;
					break;
				case "ctrl+down":
					newRowIndex = getDataEdge({ rowIndex, columnId }, "down").rowIndex;
					break;
				case "ctrl+left":
					newColumnId = getDataEdge({ rowIndex, columnId }, "left").columnId;
					break;
				case "ctrl+right":
					newColumnId = getDataEdge({ rowIndex, columnId }, "right").columnId;
					break;
				case "pageup":
					if (rowVirtualizer) {
						const visibleRange = rowVirtualizer.getVirtualItems();
						const pageSize = visibleRange.length ?? 10;
						newRowIndex = Math.max(0, rowIndex - pageSize);
					} else {
						newRowIndex = Math.max(0, rowIndex - 10);
					}
					break;
				case "pagedown":
					if (rowVirtualizer) {
						const visibleRange = rowVirtualizer.getVirtualItems();
						const pageSize = visibleRange.length ?? 10;
						newRowIndex = Math.min(rowCount - 1, rowIndex + pageSize);
					} else {
						newRowIndex = Math.min(rowCount - 1, rowIndex + 10);
					}
					break;
				case "pageleft":
					if (currentColIndex > 0) {
						const targetIndex = Math.max(
							0,
							currentColIndex - HORIZONTAL_PAGE_SIZE
						);
						const targetColumnId = navigableColumnIds[targetIndex];
						if (targetColumnId) {
							newColumnId = targetColumnId;
						}
					}
					break;
				case "pageright":
					if (currentColIndex < navigableColumnIds.length - 1) {
						const targetIndex = Math.min(
							navigableColumnIds.length - 1,
							currentColIndex + HORIZONTAL_PAGE_SIZE
						);
						const targetColumnId = navigableColumnIds[targetIndex];
						if (targetColumnId) {
							newColumnId = targetColumnId;
						}
					}
					break;
			}

			if (newRowIndex !== rowIndex || newColumnId !== columnId) {
				focusCell(newRowIndex, newColumnId);

				// Calculate and apply scrolls synchronously to avoid flashing
				const container = dataGridRef.current;
				if (!container) {
					return;
				}

				const targetRow = rowMapRef.current.get(newRowIndex);
				const cellKey = getCellKey(newRowIndex, newColumnId);
				const targetCell = cellMapRef.current.get(cellKey);

				// If target row is not rendered, scroll it into view first
				if (!targetRow) {
					if (rowVirtualizer) {
						const align =
							direction === "up" ||
							direction === "pageup" ||
							direction === "ctrl+up" ||
							direction === "ctrl+home"
								? "start"
								: direction === "down" ||
										direction === "pagedown" ||
										direction === "ctrl+down" ||
										direction === "ctrl+end"
									? "end"
									: "center";

						rowVirtualizer.scrollToIndex(newRowIndex, { align });

						// Wait for row to render before horizontal scroll
						if (newColumnId !== columnId) {
							requestAnimationFrame(() => {
								const cellKeyRetry = getCellKey(newRowIndex, newColumnId);
								const targetCellRetry = cellMapRef.current.get(cellKeyRetry);

								if (targetCellRetry) {
									const scrollDirection = getScrollDirection(direction);

									scrollCellIntoView({
										container,
										targetCell: targetCellRetry,
										tableRef,
										viewportOffset: VIEWPORT_OFFSET,
										direction: scrollDirection,
										isRtl: dir === "rtl",
									});
								}
							});
						}
					} else {
						// Use direct scroll calculation when virtualizer is not available
						const rowHeightValue = getRowHeightValue(rowHeight);
						const estimatedScrollTop = newRowIndex * rowHeightValue;
						container.scrollTop = estimatedScrollTop;
					}

					return;
				}

				// Vertical scrolling for rendered rows that changed
				if (newRowIndex !== rowIndex && targetRow) {
					requestAnimationFrame(() => {
						const containerRect = container.getBoundingClientRect();
						const headerHeight =
							headerRef.current?.getBoundingClientRect().height ?? 0;
						const footerHeight =
							footerRef.current?.getBoundingClientRect().height ?? 0;
						const viewportTop =
							containerRect.top + headerHeight + VIEWPORT_OFFSET;
						const viewportBottom =
							containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

						const rowRect = targetRow.getBoundingClientRect();
						const isFullyVisible =
							rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

						if (!isFullyVisible) {
							// Only apply vertical scroll for vertical navigation
							const isVerticalNavigation =
								direction === "up" ||
								direction === "down" ||
								direction === "pageup" ||
								direction === "pagedown" ||
								direction === "ctrl+up" ||
								direction === "ctrl+down" ||
								direction === "ctrl+home" ||
								direction === "ctrl+end";

							if (isVerticalNavigation) {
								if (
									direction === "down" ||
									direction === "pagedown" ||
									direction === "ctrl+down" ||
									direction === "ctrl+end"
								) {
									container.scrollTop += rowRect.bottom - viewportBottom;
								} else {
									container.scrollTop -= viewportTop - rowRect.top;
								}
							}
						}
					});
				}

				// Horizontal scrolling for rendered cells
				if (newColumnId !== columnId && targetCell) {
					requestAnimationFrame(() => {
						const scrollDirection = getScrollDirection(direction);

						scrollCellIntoView({
							container,
							targetCell,
							tableRef,
							viewportOffset: VIEWPORT_OFFSET,
							direction: scrollDirection,
							isRtl: dir === "rtl",
						});
					});
				}
			}
		},
		[
			dir,
			store,
			navigableColumnIds,
			focusCell,
			propsRef,
			rowHeight,
			getDataEdge,
		]
	);

	return { ...gridContext, getDataEdge, navigateCell, onRowsDelete };
}

type DataGridNavigationContext<TData> = ReturnType<
	typeof useDataGridNavigation<TData>
>;

export { type DataGridNavigationContext, useDataGridNavigation };
