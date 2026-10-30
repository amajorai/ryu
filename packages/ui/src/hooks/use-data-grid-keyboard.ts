import { handleDataGridNavigationKey } from "@ryu/ui/hooks/use-data-grid-key-navigation.ts";
import { SEARCH_SHORTCUT_KEY } from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridVirtualizerContext } from "@ryu/ui/hooks/use-data-grid-virtualizer.ts";
import {
	formatDateToString,
	getCellKey,
	getEmptyCellValue,
	parseCellKey,
} from "@ryu/ui/lib/data-grid.ts";
import type { SearchState } from "@ryu/ui/types/data-grid.ts";
import { useCallback, useEffect, useMemo } from "react";

function useDataGridKeyboard<TData>(
	gridContext: DataGridVirtualizerContext<TData>
) {
	const {
		blurCell,
		cellMapRef,
		cutClipboardTextRef,
		dataGridRef,
		dir,
		fillOnCommitRef,
		footerRef,
		getCoreRowIds,
		getCurrentSelectionRect,
		getDataEdge,
		headerRef,
		matchIndex,
		navigableColumnIds,
		navigateCell,
		onCellsCopy,
		onCellsCut,
		onCellsPaste,
		onDataUpdate,
		onFillSelection,
		onNavigateToNextMatch,
		onNavigateToPrevMatch,
		onRedo,
		onRowsDelete,
		onScrollToRow,
		onSearch,
		onSearchOpenChange,
		onSearchQueryChange,
		onSelectionClear,
		onUndo,
		propsRef,
		recordAddedRows,
		restoreFocus,
		rowMapRef,
		rowVirtualizerRef,
		searchMatches,
		searchOpen,
		searchQuery,
		selectAll,
		selectRange,
		store,
		tableRef,
	} = gridContext;

	const onDataGridKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const currentState = store.getState();
			const { key, ctrlKey, metaKey, shiftKey, altKey } = event;
			const isCtrlPressed = ctrlKey || metaKey;

			if (
				propsRef.current.enableSearch &&
				isCtrlPressed &&
				!shiftKey &&
				key === SEARCH_SHORTCUT_KEY
			) {
				event.preventDefault();
				onSearchOpenChange(true);
				return;
			}

			if (
				propsRef.current.enableSearch &&
				currentState.searchOpen &&
				!currentState.editingCell
			) {
				if (key === "Enter") {
					event.preventDefault();
					if (shiftKey) {
						onNavigateToPrevMatch();
					} else {
						onNavigateToNextMatch();
					}
					return;
				}
				if (key === "Escape") {
					event.preventDefault();
					onSearchOpenChange(false);
					return;
				}
				return;
			}

			// Cell editing keyboard events (Enter, Tab, Escape) are handled by the cell variants
			// to ensure proper value commitment before navigation
			if (currentState.editingCell) {
				if (
					key === "Enter" &&
					isCtrlPressed &&
					!propsRef.current.readOnly &&
					currentState.selectionState.selectedCells.size > 1
				) {
					const rect = getCurrentSelectionRect();
					if (rect) {
						fillOnCommitRef.current = { cell: currentState.editingCell, rect };
					}
				}
				return;
			}

			const lowerKey = key.toLowerCase();
			if (isCtrlPressed && !altKey && !propsRef.current.readOnly) {
				if (lowerKey === "z") {
					event.preventDefault();
					if (shiftKey) {
						onRedo();
					} else {
						onUndo();
					}
					return;
				}
				if (lowerKey === "y" && !shiftKey) {
					event.preventDefault();
					onRedo();
					return;
				}
			}

			if (
				isCtrlPressed &&
				(key === "Backspace" || key === "Delete") &&
				!propsRef.current.readOnly &&
				propsRef.current.onRowsDelete
			) {
				const rowIndices = new Set<number>();

				const selectedRowIds = Object.keys(currentState.rowSelection);
				if (selectedRowIds.length > 0) {
					const currentTable = tableRef.current;
					const rows = currentTable?.getRowModel().rows ?? [];
					for (const [index, row] of rows.entries()) {
						if (currentState.rowSelection[row.id]) {
							rowIndices.add(index);
						}
					}
				} else if (currentState.selectionState.selectedCells.size > 0) {
					for (const cellKey of currentState.selectionState.selectedCells) {
						const { rowIndex } = parseCellKey(cellKey);
						rowIndices.add(rowIndex);
					}
				} else if (currentState.focusedCell) {
					rowIndices.add(currentState.focusedCell.rowIndex);
				}

				if (rowIndices.size > 0) {
					event.preventDefault();
					onRowsDelete(Array.from(rowIndices));
				}
				return;
			}

			if (!currentState.focusedCell) {
				return;
			}

			if (isCtrlPressed && !shiftKey && key === "a") {
				event.preventDefault();
				selectAll();
				return;
			}

			if (
				isCtrlPressed &&
				!shiftKey &&
				!altKey &&
				(lowerKey === "d" || lowerKey === "r") &&
				!propsRef.current.readOnly
			) {
				event.preventDefault();
				onFillSelection(lowerKey === "d" ? "down" : "right");
				return;
			}

			// Ctrl+; enters today's date, as in Excel.
			if (isCtrlPressed && key === ";" && !propsRef.current.readOnly) {
				event.preventDefault();
				const { rowIndex, columnId } = currentState.focusedCell;
				const variant =
					tableRef.current?.getColumn(columnId)?.columnDef.meta?.cell?.variant;
				if (
					variant === undefined ||
					variant === "date" ||
					variant === "short-text" ||
					variant === "long-text"
				) {
					onDataUpdate({
						rowIndex,
						columnId,
						value: formatDateToString(new Date()),
					});
				}
				return;
			}

			// Shift+Space selects the rows, Ctrl+Space the columns, of the selection.
			if (key === " " && shiftKey !== isCtrlPressed && !altKey) {
				const rect = getCurrentSelectionRect();
				const rowCount = tableRef.current?.getRowModel().rows.length ?? 0;
				const firstColumnId = shiftKey
					? navigableColumnIds[0]
					: navigableColumnIds[rect?.minCol ?? 0];
				const lastColumnId = shiftKey
					? navigableColumnIds.at(-1)
					: navigableColumnIds[rect?.maxCol ?? 0];
				if (rect && rowCount > 0 && firstColumnId && lastColumnId) {
					event.preventDefault();
					selectRange(
						{ rowIndex: shiftKey ? rect.minRow : 0, columnId: firstColumnId },
						{
							rowIndex: shiftKey ? rect.maxRow : rowCount - 1,
							columnId: lastColumnId,
						}
					);
				}
				return;
			}

			if (isCtrlPressed && !shiftKey && key === "c") {
				event.preventDefault();
				onCellsCopy();
				return;
			}

			if (
				isCtrlPressed &&
				!shiftKey &&
				key === "x" &&
				!propsRef.current.readOnly
			) {
				event.preventDefault();
				onCellsCut();
				return;
			}

			if (
				propsRef.current.enablePaste &&
				isCtrlPressed &&
				!shiftKey &&
				key === "v" &&
				!propsRef.current.readOnly
			) {
				event.preventDefault();
				onCellsPaste();
				return;
			}

			if (
				(key === "Delete" || key === "Backspace") &&
				!isCtrlPressed &&
				!propsRef.current.readOnly
			) {
				const cellsToClear =
					currentState.selectionState.selectedCells.size > 0
						? Array.from(currentState.selectionState.selectedCells)
						: currentState.focusedCell
							? [
									getCellKey(
										currentState.focusedCell.rowIndex,
										currentState.focusedCell.columnId
									),
								]
							: [];

				if (cellsToClear.length > 0) {
					event.preventDefault();

					const updates: Array<{
						rowIndex: number;
						columnId: string;
						value: unknown;
					}> = [];

					const currentTable = tableRef.current;
					const tableColumns = currentTable?.getAllColumns() ?? [];
					const columnById = new Map(tableColumns.map((c) => [c.id, c]));

					for (const cellKey of cellsToClear) {
						const { rowIndex, columnId } = parseCellKey(cellKey);
						const column = columnById.get(columnId);
						const cellVariant = column?.columnDef?.meta?.cell?.variant;
						const emptyValue = getEmptyCellValue(cellVariant);
						updates.push({ rowIndex, columnId, value: emptyValue });
					}

					onDataUpdate(updates);

					if (currentState.selectionState.selectedCells.size > 0) {
						onSelectionClear();
					}

					if (currentState.cutCells.size > 0) {
						cutClipboardTextRef.current = null;
						store.setState("cutCells", new Set());
					}
				}
				return;
			}

			if (
				key === "Enter" &&
				shiftKey &&
				!propsRef.current.readOnly &&
				propsRef.current.onRowAdd
			) {
				event.preventDefault();
				const initialRowCount = propsRef.current.data.length;
				const currentColumnId = currentState.focusedCell.columnId;
				const rowIdsBefore = getCoreRowIds();

				Promise.resolve(propsRef.current.onRowAdd())
					.then(async (result) => {
						if (result === null) {
							return;
						}

						onSelectionClear();

						const targetRowIndex = result.rowIndex ?? initialRowCount;
						const targetColumnId = result.columnId ?? currentColumnId;

						await onScrollToRow({
							rowIndex: targetRowIndex,
							columnId: targetColumnId,
						});
						recordAddedRows(rowIdsBefore);
					})
					.catch(() => {
						// Callback threw an error, don't proceed with scroll/focus
					});
				return;
			}

			handleDataGridNavigationKey({
				event,
				key,
				altKey,
				isCtrlPressed,
				shiftKey,
				currentState: {
					...currentState,
					focusedCell: currentState.focusedCell,
				},
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
			});
		},
		[
			dir,
			store,
			propsRef,
			blurCell,
			navigateCell,
			selectAll,
			onCellsCopy,
			onCellsCut,
			onCellsPaste,
			onDataUpdate,
			onSelectionClear,
			navigableColumnIds,
			selectRange,
			onSearchOpenChange,
			onNavigateToNextMatch,
			onNavigateToPrevMatch,
			onRowsDelete,
			restoreFocus,
			onScrollToRow,
			onUndo,
			onRedo,
			onFillSelection,
			getCurrentSelectionRect,
			getDataEdge,
			getCoreRowIds,
			recordAddedRows,
		]
	);

	const searchState = useMemo<SearchState | undefined>(() => {
		if (!propsRef.current.enableSearch) {
			return undefined;
		}

		return {
			searchMatches,
			matchIndex,
			searchOpen,
			onSearchOpenChange,
			searchQuery,
			onSearchQueryChange,
			onSearch,
			onNavigateToNextMatch,
			onNavigateToPrevMatch,
		};
	}, [
		propsRef,
		searchMatches,
		matchIndex,
		searchOpen,
		onSearchOpenChange,
		searchQuery,
		onSearchQueryChange,
		onSearch,
		onNavigateToNextMatch,
		onNavigateToPrevMatch,
	]);

	useEffect(() => {
		const dataGridElement = dataGridRef.current;
		if (!dataGridElement) {
			return;
		}

		dataGridElement.addEventListener("keydown", onDataGridKeyDown);
		return () => {
			dataGridElement.removeEventListener("keydown", onDataGridKeyDown);
		};
	}, [onDataGridKeyDown]);

	return { ...gridContext, searchState };
}

type DataGridKeyboardContext<TData> = ReturnType<
	typeof useDataGridKeyboard<TData>
>;

export { type DataGridKeyboardContext, useDataGridKeyboard };
