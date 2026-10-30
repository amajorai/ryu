import {
	type DataGridState,
	VIEWPORT_OFFSET,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { getCellKey, scrollCellIntoView } from "@ryu/ui/lib/data-grid.ts";
import type {
	CellPosition,
	Direction,
	NavigationDirection,
} from "@ryu/ui/types/data-grid.ts";
import type { Table } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";

interface DataGridNavigationKeyParams<TData> {
	altKey: boolean;
	blurCell: () => void;
	cellMapRef: RefObject<Map<string, HTMLDivElement>>;
	currentState: DataGridState & { focusedCell: CellPosition };
	dataGridRef: RefObject<HTMLDivElement | null>;
	dir: Direction;
	event: KeyboardEvent;
	footerRef: RefObject<HTMLDivElement | null>;
	getDataEdge: (
		from: CellPosition,
		direction: "up" | "down" | "left" | "right"
	) => CellPosition;
	headerRef: RefObject<HTMLDivElement | null>;
	isCtrlPressed: boolean;
	key: string;
	navigableColumnIds: string[];
	navigateCell: (direction: NavigationDirection) => void;
	onSelectionClear: () => void;
	propsRef: RefObject<{ data: TData[] }>;
	restoreFocus: (element: HTMLDivElement | null) => void;
	rowMapRef: RefObject<Map<number, HTMLDivElement>>;
	rowVirtualizerRef: RefObject<Virtualizer<HTMLDivElement, Element> | null>;
	selectRange: (start: CellPosition, end: CellPosition) => void;
	shiftKey: boolean;
	tableRef: RefObject<Table<TData> | null>;
}

/** Arrow/Home/End/Page/Tab/Escape handling for the grid keydown listener. */
function handleDataGridNavigationKey<TData>(
	params: DataGridNavigationKeyParams<TData>
): void {
	const {
		event,
		key,
		altKey,
		isCtrlPressed,
		shiftKey,
		currentState,
		dir,
		navigableColumnIds,
		tableRef,
		propsRef,
		dataGridRef,
		rowVirtualizerRef,
		rowMapRef,
		cellMapRef,
		headerRef,
		footerRef,
		getDataEdge,
		selectRange,
		restoreFocus,
		onSelectionClear,
		blurCell,
		navigateCell,
	} = params;
	let direction: NavigationDirection | null = null;

	switch (key) {
		case "ArrowUp":
			if (altKey && !isCtrlPressed && !shiftKey) {
				direction = "pageup";
			} else if (isCtrlPressed && shiftKey) {
				const selectionEdge =
					currentState.selectionState.selectionRange?.end ||
					currentState.focusedCell;
				const currentColIndex = navigableColumnIds.indexOf(
					selectionEdge.columnId
				);
				const selectionStart =
					currentState.selectionState.selectionRange?.start ||
					currentState.focusedCell;

				const edgeColumnId =
					navigableColumnIds[currentColIndex] ?? selectionEdge.columnId;
				const edgeRowIndex = getDataEdge(
					{ rowIndex: selectionEdge.rowIndex, columnId: edgeColumnId },
					"up"
				).rowIndex;
				selectRange(selectionStart, {
					rowIndex: edgeRowIndex,
					columnId: edgeColumnId,
				});

				const rowVirtualizer = rowVirtualizerRef.current;
				if (rowVirtualizer) {
					rowVirtualizer.scrollToIndex(edgeRowIndex, { align: "start" });
				}

				restoreFocus(dataGridRef.current);

				event.preventDefault();
				return;
			} else if (isCtrlPressed && !shiftKey) {
				direction = "ctrl+up";
			} else {
				direction = "up";
			}
			break;
		case "ArrowDown":
			if (altKey && !isCtrlPressed && !shiftKey) {
				direction = "pagedown";
			} else if (isCtrlPressed && shiftKey) {
				const rowCount =
					tableRef.current?.getRowModel().rows.length ||
					propsRef.current.data.length;
				const selectionEdge =
					currentState.selectionState.selectionRange?.end ||
					currentState.focusedCell;
				const currentColIndex = navigableColumnIds.indexOf(
					selectionEdge.columnId
				);
				const selectionStart =
					currentState.selectionState.selectionRange?.start ||
					currentState.focusedCell;

				const edgeColumnId =
					navigableColumnIds[currentColIndex] ?? selectionEdge.columnId;
				const edgeRowIndex = Math.min(
					Math.max(0, rowCount - 1),
					getDataEdge(
						{ rowIndex: selectionEdge.rowIndex, columnId: edgeColumnId },
						"down"
					).rowIndex
				);
				selectRange(selectionStart, {
					rowIndex: edgeRowIndex,
					columnId: edgeColumnId,
				});

				const rowVirtualizer = rowVirtualizerRef.current;
				if (rowVirtualizer) {
					rowVirtualizer.scrollToIndex(edgeRowIndex, { align: "end" });
				}

				restoreFocus(dataGridRef.current);

				event.preventDefault();
				return;
			} else if (isCtrlPressed && !shiftKey) {
				direction = "ctrl+down";
			} else {
				direction = "down";
			}
			break;
		case "ArrowLeft":
			if (isCtrlPressed && shiftKey) {
				const selectionEdge =
					currentState.selectionState.selectionRange?.end ||
					currentState.focusedCell;
				const selectionStart =
					currentState.selectionState.selectionRange?.start ||
					currentState.focusedCell;
				const targetColumnId = getDataEdge(selectionEdge, "left").columnId;

				if (targetColumnId) {
					selectRange(selectionStart, {
						rowIndex: selectionEdge.rowIndex,
						columnId: targetColumnId,
					});

					const container = dataGridRef.current;
					const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
					const targetCell = cellMapRef.current.get(cellKey);
					if (container && targetCell) {
						scrollCellIntoView({
							container,
							targetCell,
							tableRef,
							viewportOffset: VIEWPORT_OFFSET,
							direction: "home",
							isRtl: dir === "rtl",
						});
					}

					restoreFocus(container);
				}
				event.preventDefault();
				return;
			}
			if (isCtrlPressed && !shiftKey) {
				direction = "ctrl+left";
			} else {
				direction = "left";
			}
			break;
		case "ArrowRight":
			if (isCtrlPressed && shiftKey) {
				const selectionEdge =
					currentState.selectionState.selectionRange?.end ||
					currentState.focusedCell;
				const selectionStart =
					currentState.selectionState.selectionRange?.start ||
					currentState.focusedCell;
				const targetColumnId = getDataEdge(selectionEdge, "right").columnId;

				if (targetColumnId) {
					selectRange(selectionStart, {
						rowIndex: selectionEdge.rowIndex,
						columnId: targetColumnId,
					});

					const container = dataGridRef.current;
					const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
					const targetCell = cellMapRef.current.get(cellKey);
					if (container && targetCell) {
						scrollCellIntoView({
							container,
							targetCell,
							tableRef,
							viewportOffset: VIEWPORT_OFFSET,
							direction: "end",
							isRtl: dir === "rtl",
						});
					}

					restoreFocus(container);
				}
				event.preventDefault();
				return;
			}
			if (isCtrlPressed && !shiftKey) {
				direction = "ctrl+right";
			} else {
				direction = "right";
			}
			break;
		case "Home":
			direction = isCtrlPressed ? "ctrl+home" : "home";
			break;
		case "End":
			direction = isCtrlPressed ? "ctrl+end" : "end";
			break;
		case "PageUp":
			direction = altKey ? "pageleft" : "pageup";
			break;
		case "PageDown":
			direction = altKey ? "pageright" : "pagedown";
			break;
		case "Escape":
			event.preventDefault();
			if (
				currentState.selectionState.selectedCells.size > 0 ||
				Object.keys(currentState.rowSelection).length > 0
			) {
				onSelectionClear();
			} else {
				blurCell();
			}
			return;
		case "Tab":
			event.preventDefault();
			if (dir === "rtl") {
				direction = event.shiftKey ? "right" : "left";
			} else {
				direction = event.shiftKey ? "left" : "right";
			}
			break;
	}

	if (direction) {
		event.preventDefault();

		if (shiftKey && key !== "Tab" && currentState.focusedCell) {
			const selectionEdge =
				currentState.selectionState.selectionRange?.end ||
				currentState.focusedCell;

			const currentColIndex = navigableColumnIds.indexOf(
				selectionEdge.columnId
			);
			let newRowIndex = selectionEdge.rowIndex;
			let newColumnId = selectionEdge.columnId;

			const isRtl = dir === "rtl";

			const rowCount =
				tableRef.current?.getRowModel().rows.length ||
				propsRef.current.data.length;

			switch (direction) {
				case "up":
					newRowIndex = Math.max(0, selectionEdge.rowIndex - 1);
					break;
				case "down":
					newRowIndex = Math.min(rowCount - 1, selectionEdge.rowIndex + 1);
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
						newColumnId = navigableColumnIds[0] ?? newColumnId;
					}
					break;
				case "end":
					if (navigableColumnIds.length > 0) {
						newColumnId = navigableColumnIds.at(-1) ?? newColumnId;
					}
					break;
			}

			const selectionStart =
				currentState.selectionState.selectionRange?.start ||
				currentState.focusedCell;

			selectRange(selectionStart, {
				rowIndex: newRowIndex,
				columnId: newColumnId,
			});

			const container = dataGridRef.current;
			const targetRow = rowMapRef.current.get(newRowIndex);
			const cellKey = getCellKey(newRowIndex, newColumnId);
			const targetCell = cellMapRef.current.get(cellKey);

			if (
				newRowIndex !== selectionEdge.rowIndex &&
				(direction === "up" || direction === "down")
			) {
				if (container && targetRow) {
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
						const scrollNeeded =
							direction === "down"
								? rowRect.bottom - viewportBottom
								: viewportTop - rowRect.top;

						if (direction === "down") {
							container.scrollTop += scrollNeeded;
						} else {
							container.scrollTop -= scrollNeeded;
						}

						restoreFocus(container);
					}
				} else {
					const rowVirtualizer = rowVirtualizerRef.current;
					if (rowVirtualizer) {
						const align = direction === "up" ? "start" : "end";
						rowVirtualizer.scrollToIndex(newRowIndex, { align });

						restoreFocus(container);
					}
				}
			}

			if (
				newColumnId !== selectionEdge.columnId &&
				(direction === "left" ||
					direction === "right" ||
					direction === "home" ||
					direction === "end") &&
				container &&
				targetCell
			) {
				scrollCellIntoView({
					container,
					targetCell,
					tableRef,
					viewportOffset: VIEWPORT_OFFSET,
					direction,
					isRtl,
				});
			}
		} else {
			if (currentState.selectionState.selectedCells.size > 0) {
				onSelectionClear();
			}
			navigateCell(direction);
		}
	}
}

export { handleDataGridNavigationKey };
