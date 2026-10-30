import { useLiteralMessages } from "@ryu/i18n/react";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { convertPastedCellValue } from "@ryu/ui/hooks/use-data-grid-paste-value.ts";
import type { DataGridSelectionContext } from "@ryu/ui/hooks/use-data-grid-selection.ts";
import {
	getCellKey,
	getEmptyCellValue,
	parseCellKey,
	parseTsv,
} from "@ryu/ui/lib/data-grid.ts";
import { isCutOnClipboard } from "@ryu/ui/lib/data-grid-clipboard.ts";
import type { CellUpdate } from "@ryu/ui/types/data-grid.ts";
import { useCallback } from "react";
import { toast } from "sonner";

function useDataGridPaste<TData>(gridContext: DataGridSelectionContext<TData>) {
	const {
		cellMapRef,
		cutClipboardTextRef,
		dataGridRef,
		focusGuardRef,
		historyRef,
		navigableColumnIds,
		onDataUpdate,
		propsRef,
		recordPasteAddedRows,
		restoreFocus,
		selectRange,
		store,
		tableRef,
	} = gridContext;
	const literalMessages = useLiteralMessages();
	const literalMessagesRef = useAsRef(literalMessages);

	const onCellsPaste = useCallback(
		async (
			expandRows = false,
			overrideText?: string,
			// Raw clipboard text when `overrideText` is a transform of it; the
			// stale-cut check compares this, not the transformed paste text.
			sourceClipboardText?: string
		) => {
			if (propsRef.current.readOnly) {
				return;
			}

			const currentState = store.getState();
			if (!currentState.focusedCell) {
				return;
			}

			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows;
			if (!rows) {
				return;
			}

			try {
				const dialogText = currentState.pasteDialog.clipboardText;
				let clipboardText = dialogText || overrideText || "";
				let cutSourceText = dialogText
					? (currentState.pasteDialog.sourceClipboardText ?? dialogText)
					: (sourceClipboardText ?? clipboardText);

				if (!clipboardText) {
					clipboardText = await navigator.clipboard.readText();
					if (!clipboardText) {
						return;
					}
					cutSourceText = clipboardText;
				}

				const rawPastedData = parseTsv(
					clipboardText,
					navigableColumnIds.length
				);

				// Fill entire selection when clipboard has a single value and multiple cells are selected
				const selectionCells = currentState.selectionState.selectedCells;
				const isSingleCellClipboard =
					rawPastedData.length === 1 && (rawPastedData[0]?.length ?? 0) === 1;

				let pastedData = rawPastedData;
				let startRowIndex = currentState.focusedCell.rowIndex;
				let startColIndex = navigableColumnIds.indexOf(
					currentState.focusedCell.columnId
				);

				if (isSingleCellClipboard && selectionCells.size > 1) {
					const singleValue = rawPastedData[0]?.[0] ?? "";
					let minRow = Number.POSITIVE_INFINITY;
					let maxRow = Number.NEGATIVE_INFINITY;
					let minColIdx = Number.POSITIVE_INFINITY;
					let maxColIdx = Number.NEGATIVE_INFINITY;

					for (const cellKey of selectionCells) {
						const { rowIndex, columnId } = parseCellKey(cellKey);
						const colIdx = navigableColumnIds.indexOf(columnId);
						if (colIdx === -1) {
							continue;
						}
						minRow = Math.min(minRow, rowIndex);
						maxRow = Math.max(maxRow, rowIndex);
						minColIdx = Math.min(minColIdx, colIdx);
						maxColIdx = Math.max(maxColIdx, colIdx);
					}

					if (minRow !== Number.POSITIVE_INFINITY) {
						startRowIndex = minRow;
						startColIndex = minColIdx;
						const numRows = maxRow - minRow + 1;
						const numCols = maxColIdx - minColIdx + 1;
						pastedData = Array.from({ length: numRows }, () =>
							Array.from({ length: numCols }, () => singleValue)
						);
					}
				}

				if (startColIndex === -1) {
					return;
				}

				const rowCount = rows.length ?? propsRef.current.data.length;
				const rowsNeeded = startRowIndex + pastedData.length - rowCount;

				if (
					rowsNeeded > 0 &&
					!expandRows &&
					propsRef.current.onRowAdd &&
					!currentState.pasteDialog.clipboardText
				) {
					store.setState("pasteDialog", {
						open: true,
						rowsNeeded,
						clipboardText,
						sourceClipboardText: cutSourceText,
					});
					return;
				}

				// Rows a paste adds are undone together with the pasted values.
				let rowIdsBeforeExpand: Set<string> | null = null;
				if (expandRows && rowsNeeded > 0) {
					const expectedRowCount = rowCount + rowsNeeded;
					rowIdsBeforeExpand = new Set(
						(tableRef.current?.getCoreRowModel().rows ?? []).map((r) => r.id)
					);

					if (propsRef.current.onRowsAdd) {
						await propsRef.current.onRowsAdd(rowsNeeded);
					} else if (propsRef.current.onRowAdd) {
						for (let i = 0; i < rowsNeeded; i++) {
							await propsRef.current.onRowAdd();
						}
					}

					let attempts = 0;
					const maxAttempts = 50;
					let currentTableRowCount =
						tableRef.current?.getRowModel().rows.length ?? 0;

					while (
						currentTableRowCount < expectedRowCount &&
						attempts < maxAttempts
					) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						currentTableRowCount =
							tableRef.current?.getRowModel().rows.length ?? 0;
						attempts++;
					}
				}

				const updates: CellUpdate[] = [];
				const tableColumns = currentTable?.getAllColumns() ?? [];
				let cellsUpdated = 0;
				let endRowIndex = startRowIndex;
				let endColIndex = startColIndex;

				const updatedTable = tableRef.current;
				const updatedRows = updatedTable?.getRowModel().rows;
				const currentRowCount = updatedRows?.length ?? 0;

				let cellsSkipped = 0;

				const columnMap = new Map(tableColumns.map((c) => [c.id, c]));

				for (
					let pasteRowIdx = 0;
					pasteRowIdx < pastedData.length;
					pasteRowIdx++
				) {
					const pasteRow = pastedData[pasteRowIdx];
					if (!pasteRow) {
						continue;
					}

					const targetRowIndex = startRowIndex + pasteRowIdx;
					if (targetRowIndex >= currentRowCount) {
						break;
					}

					for (
						let pasteColIdx = 0;
						pasteColIdx < pasteRow.length;
						pasteColIdx++
					) {
						const targetColIndex = startColIndex + pasteColIdx;
						if (targetColIndex >= navigableColumnIds.length) {
							break;
						}

						const targetColumnId = navigableColumnIds[targetColIndex];
						if (!targetColumnId) {
							continue;
						}

						const pastedValue = pasteRow[pasteColIdx] ?? "";
						const column = columnMap.get(targetColumnId);
						const cellOpts = column?.columnDef?.meta?.cell;
						const { processedValue, shouldSkip } = convertPastedCellValue(
							pastedValue,
							cellOpts
						);

						if (shouldSkip) {
							cellsSkipped++;
							endRowIndex = Math.max(endRowIndex, targetRowIndex);
							endColIndex = Math.max(endColIndex, targetColIndex);
							continue;
						}

						updates.push({
							rowIndex: targetRowIndex,
							columnId: targetColumnId,
							value: processedValue,
						});
						cellsUpdated++;

						endRowIndex = Math.max(endRowIndex, targetRowIndex);
						endColIndex = Math.max(endColIndex, targetColIndex);
					}
				}

				const undoDepthBeforePaste = historyRef.current.undo.length;

				if (updates.length > 0) {
					if (propsRef.current.onPaste) {
						await propsRef.current.onPaste(updates);
					}

					const allUpdates = [...updates];
					const isCutStillOnClipboard = isCutOnClipboard(
						cutClipboardTextRef.current,
						cutSourceText
					);

					if (currentState.cutCells.size > 0 && isCutStillOnClipboard) {
						const columnById = new Map(tableColumns.map((c) => [c.id, c]));
						// A move that overlaps its source keeps the pasted values.
						const pastedKeys = new Set(
							updates.map((u) => getCellKey(u.rowIndex, u.columnId))
						);

						for (const cellKey of currentState.cutCells) {
							if (pastedKeys.has(cellKey)) {
								continue;
							}
							const { rowIndex, columnId } = parseCellKey(cellKey);
							const column = columnById.get(columnId);
							const cellVariant = column?.columnDef?.meta?.cell?.variant;
							const emptyValue = getEmptyCellValue(cellVariant);
							allUpdates.push({ rowIndex, columnId, value: emptyValue });
						}
					}
					if (currentState.cutCells.size > 0) {
						cutClipboardTextRef.current = null;
						store.setState("cutCells", new Set());
					}

					onDataUpdate(allUpdates);

					if (cellsSkipped > 0) {
						toast.success(
							literalMessagesRef.current(
								"{count, plural, one {{countText} cell} other {{countText} cells}} pasted, {skippedText} skipped",
								{
									count: cellsUpdated,
									countText: String(cellsUpdated),
									skippedText: String(cellsSkipped),
								}
							)
						);
					} else {
						toast.success(
							literalMessagesRef.current(
								"{count, plural, one {{countText} cell} other {{countText} cells}} pasted",
								{ count: cellsUpdated, countText: String(cellsUpdated) }
							)
						);
					}

					const endColumnId = navigableColumnIds[endColIndex];
					if (endColumnId) {
						selectRange(
							{
								rowIndex: startRowIndex,
								columnId: currentState.focusedCell.columnId,
							},
							{ rowIndex: endRowIndex, columnId: endColumnId }
						);
					}

					restoreFocus(dataGridRef.current);
				} else if (cellsSkipped > 0) {
					toast.error(
						literalMessagesRef.current(
							"{count, plural, one {{countText} cell} other {{countText} cells}} skipped pasting for invalid data",
							{ count: cellsSkipped, countText: String(cellsSkipped) }
						)
					);
				}

				if (rowIdsBeforeExpand) {
					recordPasteAddedRows(rowIdsBeforeExpand, undoDepthBeforePaste);
				}

				if (currentState.pasteDialog.open) {
					store.setState("pasteDialog", {
						open: false,
						rowsNeeded: 0,
						clipboardText: "",
					});
				}
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to paste. Please try again."
				);
			}
		},
		[
			store,
			navigableColumnIds,
			propsRef,
			historyRef,
			onDataUpdate,
			recordPasteAddedRows,
			selectRange,
			restoreFocus,
		]
	);

	// Release focus guard after delay to allow async data re-renders to settle.
	// 300ms accounts for db sync and virtualized cell mounting
	const releaseFocusGuard = useCallback((immediate = false) => {
		if (immediate) {
			focusGuardRef.current = false;
			return;
		}

		setTimeout(() => {
			focusGuardRef.current = false;
		}, 300);
	}, []);

	const focusCellWrapper = useCallback(
		(rowIndex: number, columnId: string) => {
			focusGuardRef.current = true;

			requestAnimationFrame(() => {
				const cellKey = getCellKey(rowIndex, columnId);
				const cellWrapperElement = cellMapRef.current.get(cellKey);

				if (!cellWrapperElement) {
					const container = dataGridRef.current;
					if (container) {
						container.focus();
					}
					releaseFocusGuard();
					return;
				}

				cellWrapperElement.focus();
				releaseFocusGuard();
			});
		},
		[releaseFocusGuard]
	);

	const focusCell = useCallback(
		(rowIndex: number, columnId: string) => {
			store.batch(() => {
				store.setState("focusedCell", { rowIndex, columnId });
				store.setState("editingCell", null);
			});

			const currentState = store.getState();

			if (currentState.searchOpen) {
				return;
			}

			focusCellWrapper(rowIndex, columnId);
		},
		[store, focusCellWrapper]
	);

	return {
		...gridContext,
		focusCell,
		focusCellWrapper,
		onCellsPaste,
		releaseFocusGuard,
	};
}

type DataGridPasteContext<TData> = ReturnType<typeof useDataGridPaste<TData>>;

export { type DataGridPasteContext, useDataGridPaste };
