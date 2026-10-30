import { useLiteralMessages } from "@ryu/i18n/react";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import {
	type HistoryEntry,
	NON_NAVIGABLE_COLUMN_IDS,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridStateContext } from "@ryu/ui/hooks/use-data-grid-state.ts";
import { getCellKey, parseCellKey } from "@ryu/ui/lib/data-grid.ts";
import { normalizeClipboardText } from "@ryu/ui/lib/data-grid-clipboard.ts";
import type { CellPosition } from "@ryu/ui/types/data-grid.ts";
import type { Row } from "@tanstack/react-table";
import { useCallback } from "react";
import { toast } from "sonner";

function useDataGridSelection<TData>(gridContext: DataGridStateContext<TData>) {
	const {
		columnIds,
		cutClipboardTextRef,
		dir,
		historyRef,
		propsRef,
		pushHistory,
		rowHeightValue,
		store,
		tableRef,
	} = gridContext;
	const literalMessages = useLiteralMessages();
	const literalMessagesRef = useAsRef(literalMessages);

	const selectAll = useCallback(() => {
		const allCells = new Set<string>();
		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows ?? [];
		const rowCount = rows.length ?? propsRef.current.data.length;

		for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
			for (const columnId of columnIds) {
				allCells.add(getCellKey(rowIndex, columnId));
			}
		}

		const firstColumnId = columnIds[0];
		const lastColumnId = columnIds.at(-1);

		store.setState("selectionState", {
			selectedCells: allCells,
			selectionRange:
				columnIds.length > 0 && rowCount > 0 && firstColumnId && lastColumnId
					? {
							start: { rowIndex: 0, columnId: firstColumnId },
							end: { rowIndex: rowCount - 1, columnId: lastColumnId },
						}
					: null,
			isSelecting: false,
		});
	}, [columnIds, propsRef, store]);

	const selectColumn = useCallback(
		(columnId: string) => {
			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows ?? [];
			const rowCount = rows.length ?? propsRef.current.data.length;

			if (rowCount === 0) {
				return;
			}

			const selectedCells = new Set<string>();

			for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
				selectedCells.add(getCellKey(rowIndex, columnId));
			}

			store.setState("selectionState", {
				selectedCells,
				selectionRange: {
					start: { rowIndex: 0, columnId },
					end: { rowIndex: rowCount - 1, columnId },
				},
				isSelecting: false,
			});
		},
		[propsRef, store]
	);

	const selectRange = useCallback(
		(start: CellPosition, end: CellPosition, isSelecting = false) => {
			const startColIndex = columnIds.indexOf(start.columnId);
			const endColIndex = columnIds.indexOf(end.columnId);

			const minRow = Math.min(start.rowIndex, end.rowIndex);
			const maxRow = Math.max(start.rowIndex, end.rowIndex);
			const minCol = Math.min(startColIndex, endColIndex);
			const maxCol = Math.max(startColIndex, endColIndex);

			const selectedCells = new Set<string>();

			for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
				for (let colIndex = minCol; colIndex <= maxCol; colIndex++) {
					const columnId = columnIds[colIndex];
					if (columnId) {
						selectedCells.add(getCellKey(rowIndex, columnId));
					}
				}
			}

			store.setState("selectionState", {
				selectedCells,
				selectionRange: { start, end },
				isSelecting,
			});
		},
		[columnIds, store]
	);

	const dragDepsRef = useAsRef({
		selectRange,
		dir,
		rowHeightValue,
		columnIds,
	});

	const serializeCellsToTsv = useCallback(() => {
		const currentState = store.getState();

		let selectedCellsArray: string[];
		if (currentState.selectionState.selectedCells.size) {
			selectedCellsArray = Array.from(
				currentState.selectionState.selectedCells
			);
		} else {
			if (!currentState.focusedCell) {
				return null;
			}
			const focusedCellKey = getCellKey(
				currentState.focusedCell.rowIndex,
				currentState.focusedCell.columnId
			);
			selectedCellsArray = [focusedCellKey];
		}

		const currentTable = tableRef.current;
		const rows = currentTable?.getRowModel().rows;
		if (!rows) {
			return null;
		}

		const selectedColumnIds: string[] = [];
		const seenColumnIds = new Set<string>();
		const cellData = new Map<string, string>();
		const rowIndices = new Set<number>();
		const rowCellMaps = new Map<
			number,
			Map<string, ReturnType<Row<TData>["getVisibleCells"]>[number]>
		>();
		const navigableCells: string[] = [];

		for (const cellKey of selectedCellsArray) {
			const { rowIndex, columnId } = parseCellKey(cellKey);

			if (columnId && NON_NAVIGABLE_COLUMN_IDS.has(columnId)) {
				continue;
			}

			navigableCells.push(cellKey);

			if (columnId && !seenColumnIds.has(columnId)) {
				seenColumnIds.add(columnId);
				selectedColumnIds.push(columnId);
			}

			rowIndices.add(rowIndex);

			const row = rows[rowIndex];
			if (row) {
				let cellMap = rowCellMaps.get(rowIndex);
				if (!cellMap) {
					cellMap = new Map(row.getVisibleCells().map((c) => [c.column.id, c]));
					rowCellMaps.set(rowIndex, cellMap);
				}
				const cell = cellMap.get(columnId);
				if (cell) {
					const value = cell.getValue();
					const cellVariant = cell.column.columnDef?.meta?.cell?.variant;

					let serializedValue = "";
					if (cellVariant === "file" || cellVariant === "multi-select") {
						serializedValue = value ? JSON.stringify(value) : "";
					} else if (value instanceof Date) {
						serializedValue = value.toISOString();
					} else {
						serializedValue = String(value ?? "");
					}

					cellData.set(cellKey, serializedValue);
				}
			}
		}

		const colIndices = new Set<number>();
		for (const cellKey of navigableCells) {
			const { columnId } = parseCellKey(cellKey);
			const colIndex = selectedColumnIds.indexOf(columnId);
			if (colIndex >= 0) {
				colIndices.add(colIndex);
			}
		}

		const sortedRowIndices = Array.from(rowIndices).sort((a, b) => a - b);
		const sortedColIndices = Array.from(colIndices).sort((a, b) => a - b);
		const sortedColumnIds = sortedColIndices.map((i) => selectedColumnIds[i]);

		const tsvData = sortedRowIndices
			.map((rowIndex) =>
				sortedColumnIds
					.map((columnId) => {
						const cellKey = `${rowIndex}:${columnId}`;
						return cellData.get(cellKey) ?? "";
					})
					.join("\t")
			)
			.join("\n");

		return { tsvData, selectedCellsArray: navigableCells };
	}, [store]);

	const onCellsCopy = useCallback(async () => {
		const result = serializeCellsToTsv();
		if (!result) {
			return;
		}

		const { tsvData, selectedCellsArray } = result;

		try {
			await navigator.clipboard.writeText(tsvData);

			const currentState = store.getState();
			cutClipboardTextRef.current = null;
			if (currentState.cutCells.size > 0) {
				store.setState("cutCells", new Set());
			}

			toast.success(
				literalMessagesRef.current(
					"{count, plural, one {{countText} cell} other {{countText} cells}} copied",
					{
						count: selectedCellsArray.length,
						countText: String(selectedCellsArray.length),
					}
				)
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to copy to clipboard"
			);
		}
	}, [store, serializeCellsToTsv, literalMessagesRef]);

	const onCellsCut = useCallback(async () => {
		if (propsRef.current.readOnly) {
			return;
		}

		const result = serializeCellsToTsv();
		if (!result) {
			return;
		}

		const { tsvData, selectedCellsArray } = result;

		try {
			await navigator.clipboard.writeText(tsvData);

			cutClipboardTextRef.current = normalizeClipboardText(tsvData);
			store.setState("cutCells", new Set(selectedCellsArray));

			toast.success(
				literalMessagesRef.current(
					"{count, plural, one {{countText} cell} other {{countText} cells}} cut",
					{
						count: selectedCellsArray.length,
						countText: String(selectedCellsArray.length),
					}
				)
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to cut to clipboard"
			);
		}
	}, [store, propsRef, serializeCellsToTsv, literalMessagesRef]);

	const restoreFocus = useCallback((element: HTMLDivElement | null) => {
		if (element && document.activeElement !== element) {
			requestAnimationFrame(() => {
				element.focus();
			});
		}
	}, []);

	// Fold the rows a paste appended into the paste's undo step, so one Ctrl+Z
	// clears the values and removes the rows it created.
	const recordPasteAddedRows = useCallback(
		(rowIdsBefore: Set<string>, undoDepthBefore: number) => {
			const added = (tableRef.current?.getCoreRowModel().rows ?? []).filter(
				(row) => !rowIdsBefore.has(row.id)
			);
			if (added.length === 0) {
				return;
			}
			const rowsEntry: HistoryEntry<TData> = {
				kind: "rows-inserted",
				rows: added.map((row) => ({
					rowId: row.id,
					dataIndex: row.index,
					original: null,
				})),
			};
			const history = historyRef.current;
			const cellsEntry =
				history.undo.length > undoDepthBefore ? history.undo.pop() : undefined;
			pushHistory(
				cellsEntry
					? { kind: "group", entries: [rowsEntry, cellsEntry] }
					: rowsEntry
			);
		},
		[historyRef, pushHistory]
	);

	return {
		...gridContext,
		dragDepsRef,
		onCellsCopy,
		onCellsCut,
		recordPasteAddedRows,
		restoreFocus,
		selectAll,
		selectColumn,
		selectRange,
	};
}

type DataGridSelectionContext<TData> = ReturnType<
	typeof useDataGridSelection<TData>
>;

export { type DataGridSelectionContext, useDataGridSelection };
