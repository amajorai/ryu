import type { DataGridFillContext } from "@ryu/ui/hooks/use-data-grid-fill.ts";
import {
	AUTO_FIT_CELL_PADDING,
	AUTO_FIT_CHIP_PADDING,
	AUTO_FIT_HEADER_CHROME,
	AUTO_FIT_ROW_LIMIT,
	type CellChange,
	type HistoryEntry,
	MAX_COLUMN_SIZE,
	MIN_COLUMN_SIZE,
	type RowSnapshot,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { getCellKey, parseTsv } from "@ryu/ui/lib/data-grid.ts";
import {
	type GridRect,
	getCellDisplayText,
	serializeTsv,
	transposeMatrix,
} from "@ryu/ui/lib/data-grid-fill.ts";
import type { CellUpdate } from "@ryu/ui/types/data-grid.ts";
import { useCallback, useRef } from "react";
import { toast } from "sonner";

function useDataGridHistory<TData>(gridContext: DataGridFillContext<TData>) {
	const {
		applyDataUpdate,
		applyFill,
		dataGridRef,
		focusCell,
		getCurrentSelectionRect,
		historyRef,
		navigableColumnIds,
		onCellsPaste,
		propsRef,
		pushHistory,
		selectRange,
		store,
		tableRef,
	} = gridContext;

	// Ctrl+D / Ctrl+R: copy the selection's first row (column) across the rest of
	// it; a single row (column) copies from the one above (before) it.
	const onFillSelection = useCallback(
		(direction: "down" | "right") => {
			const rect = getCurrentSelectionRect();
			if (!rect || propsRef.current.readOnly) {
				return;
			}
			let source: GridRect;
			let count: number;
			if (direction === "down") {
				if (rect.minRow === rect.maxRow) {
					if (rect.minRow === 0) {
						return;
					}
					source = {
						...rect,
						minRow: rect.minRow - 1,
						maxRow: rect.minRow - 1,
					};
					count = 1;
				} else {
					source = { ...rect, maxRow: rect.minRow };
					count = rect.maxRow - rect.minRow;
				}
			} else if (rect.minCol === rect.maxCol) {
				if (rect.minCol === 0) {
					return;
				}
				source = { ...rect, minCol: rect.minCol - 1, maxCol: rect.minCol - 1 };
				count = 1;
			} else {
				source = { ...rect, maxCol: rect.minCol };
				count = rect.maxCol - rect.minCol;
			}
			applyFill(source, { direction, count }, "copy");
		},
		[propsRef, getCurrentSelectionRect, applyFill]
	);

	// Remove rows by stable id without recording history; returns what was removed.
	const removeRowsById = useCallback(
		async (rowIds: Set<string>): Promise<RowSnapshot<TData>[]> => {
			const rows = tableRef.current?.getCoreRowModel().rows ?? [];
			const found = rows.filter((row) => rowIds.has(row.id));
			const onDelete = propsRef.current.onRowsDelete;
			if (found.length === 0 || !onDelete) {
				return [];
			}
			await onDelete(
				found.map((row) => row.original),
				found.map((row) => row.index)
			);
			return found.map((row) => ({
				rowId: row.id,
				dataIndex: row.index,
				original: row.original,
			}));
		},
		[propsRef]
	);

	// Put removed rows back at their former positions, keeping their identity.
	const restoreRows = useCallback(
		async (snapshots: RowSnapshot<TData>[]) => {
			const onInsert = propsRef.current.onRowsInsert;
			if (!onInsert) {
				return;
			}
			const ordered = [...snapshots].sort((a, b) => a.dataIndex - b.dataIndex);
			for (const snapshot of ordered) {
				if (snapshot.original !== null) {
					await onInsert({
						index: snapshot.dataIndex,
						count: 1,
						source: [snapshot.original],
						restore: true,
					});
				}
			}
		},
		[propsRef]
	);

	const replayingRef = useRef(false);

	const replayCells = useCallback(
		(changes: CellChange[], kind: "undo" | "redo") => {
			const rows = tableRef.current?.getRowModel().rows ?? [];
			const rowIndexById = new Map(rows.map((row, index) => [row.id, index]));
			// Undo replays newest-first so a cell edited twice in one entry ends on
			// its oldest value; redo replays oldest-first.
			const ordered = kind === "undo" ? [...changes].reverse() : changes;
			const updates: CellUpdate[] = [];
			for (const change of ordered) {
				const rowIndex = rowIndexById.get(change.rowId);
				if (rowIndex !== undefined) {
					updates.push({
						rowIndex,
						columnId: change.columnId,
						value: kind === "undo" ? change.before : change.after,
					});
				}
			}
			const first = updates[0];
			if (!first) {
				return;
			}
			applyDataUpdate(updates, false);
			store.setState("selectionState", {
				selectedCells:
					updates.length > 1
						? new Set(updates.map((u) => getCellKey(u.rowIndex, u.columnId)))
						: new Set(),
				selectionRange: null,
				isSelecting: false,
			});
			focusCell(first.rowIndex, first.columnId);
		},
		[store, applyDataUpdate, focusCell]
	);

	// Replay one entry; returns the entry to push onto the opposite stack.
	const replayEntry = useCallback(
		(
			entry: HistoryEntry<TData>,
			kind: "undo" | "redo"
		): Promise<HistoryEntry<TData>> => {
			const replay = async (
				current: HistoryEntry<TData>
			): Promise<HistoryEntry<TData>> => {
				if (current.kind === "cells") {
					replayCells(current.changes, kind);
					return current;
				}
				if (current.kind === "group") {
					// Undo unwinds the group newest-first; redo replays it in order.
					const ordered =
						kind === "undo" ? [...current.entries].reverse() : current.entries;
					const replayed: HistoryEntry<TData>[] = [];
					for (const child of ordered) {
						replayed.push(await replay(child));
					}
					return {
						kind: "group",
						entries: kind === "undo" ? replayed.reverse() : replayed,
					};
				}
				// Undoing a removal and redoing an insertion both put rows back;
				// the other two directions take them out again.
				const restoring =
					(current.kind === "rows-removed") === (kind === "undo");
				if (restoring) {
					await restoreRows(current.rows);
					return current;
				}
				const removed = await removeRowsById(
					new Set(current.rows.map((row) => row.rowId))
				);
				return { kind: current.kind, rows: removed };
			};
			return replay(entry);
		},
		[replayCells, restoreRows, removeRowsById]
	);

	const replayHistory = useCallback(
		async (kind: "undo" | "redo") => {
			if (propsRef.current.readOnly || replayingRef.current) {
				return;
			}
			const history = historyRef.current;
			const entry = (kind === "undo" ? history.undo : history.redo).pop();
			if (!entry) {
				return;
			}
			const target = kind === "undo" ? history.redo : history.undo;

			if (entry.kind === "cells") {
				target.push(await replayEntry(entry, kind));
				return;
			}

			replayingRef.current = true;
			try {
				target.push(await replayEntry(entry, kind));
				if (entry.kind !== "group") {
					store.batch(() => {
						store.setState("selectionState", {
							selectedCells: new Set(),
							selectionRange: null,
							isSelecting: false,
						});
						store.setState("rowSelection", {});
					});
				}
			} finally {
				replayingRef.current = false;
			}
		},
		[propsRef, historyRef, store, replayEntry]
	);

	/**
	 * Insert empty rows above/below the selected rows, or duplicate them below
	 * (Excel's Insert and Ctrl-drag copy). Inserts as many rows as are selected.
	 */
	const onRowsInsertAt = useCallback(
		async (position: "above" | "below" | "duplicate") => {
			const onInsert = propsRef.current.onRowsInsert;
			const currentTable = tableRef.current;
			if (propsRef.current.readOnly || !onInsert || !currentTable) {
				return;
			}
			const rows = currentTable.getRowModel().rows;
			const currentState = store.getState();
			const rowSelection = currentState.rowSelection;
			let selected = rows.filter((row) => rowSelection[row.id]);
			if (selected.length === 0) {
				const rect = getCurrentSelectionRect();
				if (!rect) {
					return;
				}
				selected = rows.slice(rect.minRow, rect.maxRow + 1);
			}
			if (selected.length === 0) {
				return;
			}
			const dataIndices = selected.map((row) => row.index);
			const index =
				position === "above"
					? Math.min(...dataIndices)
					: Math.max(...dataIndices) + 1;
			const ids = await onInsert({
				index,
				count: selected.length,
				source:
					position === "duplicate"
						? selected.map((row) => row.original)
						: undefined,
			});
			if (ids && ids.length > 0) {
				pushHistory({
					kind: "rows-inserted",
					rows: ids.map((rowId, offset) => ({
						rowId,
						dataIndex: index + offset,
						original: null,
					})),
				});
			}

			const focusColumnId =
				currentState.focusedCell?.columnId ?? navigableColumnIds[0];
			requestAnimationFrame(() => {
				const nextRows = tableRef.current?.getRowModel().rows ?? [];
				const inserted = new Set(ids ?? []);
				const visual = nextRows.flatMap((row, i) =>
					inserted.has(row.id) ? [i] : []
				);
				const firstRow = visual[0];
				const lastRow = visual.at(-1);
				const firstColumnId = navigableColumnIds[0];
				const lastColumnId = navigableColumnIds.at(-1);
				if (
					firstRow === undefined ||
					lastRow === undefined ||
					!(focusColumnId && firstColumnId && lastColumnId)
				) {
					return;
				}
				focusCell(firstRow, focusColumnId);
				selectRange(
					{ rowIndex: firstRow, columnId: firstColumnId },
					{ rowIndex: lastRow, columnId: lastColumnId }
				);
			});
		},
		[
			propsRef,
			store,
			navigableColumnIds,
			getCurrentSelectionRect,
			pushHistory,
			focusCell,
			selectRange,
		]
	);

	const onCellsPasteTransposed = useCallback(async () => {
		if (propsRef.current.readOnly) {
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				return;
			}
			const matrix = parseTsv(text, navigableColumnIds.length);
			await onCellsPaste(false, serializeTsv(transposeMatrix(matrix)), text);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to read the clipboard"
			);
		}
	}, [propsRef, navigableColumnIds, onCellsPaste]);

	const onUndo = useCallback(() => replayHistory("undo"), [replayHistory]);
	const onRedo = useCallback(() => replayHistory("redo"), [replayHistory]);

	const autoFitCanvasRef = useRef<HTMLCanvasElement | null>(null);

	const onColumnAutoFit = useCallback((columnId: string) => {
		const currentTable = tableRef.current;
		const column = currentTable?.getColumn(columnId);
		if (!(currentTable && column)) {
			return;
		}
		autoFitCanvasRef.current ??= document.createElement("canvas");
		const context = autoFitCanvasRef.current.getContext("2d");
		if (!context) {
			return;
		}
		const container = dataGridRef.current;
		const fontFamily = container
			? getComputedStyle(container).fontFamily
			: "sans-serif";
		context.font = `14px ${fontFamily}`;

		const meta = column.columnDef.meta;
		let width =
			context.measureText(meta?.label ?? columnId).width +
			AUTO_FIT_HEADER_CHROME;
		const rows = currentTable.getCoreRowModel().rows;
		for (const row of rows.slice(0, AUTO_FIT_ROW_LIMIT)) {
			const { text, chips } = getCellDisplayText(
				row.getValue(columnId),
				meta?.cell
			);
			const cellWidth =
				context.measureText(text).width +
				AUTO_FIT_CELL_PADDING +
				chips * AUTO_FIT_CHIP_PADDING;
			width = Math.max(width, cellWidth);
		}

		const minSize = column.columnDef.minSize ?? MIN_COLUMN_SIZE;
		const maxSize = column.columnDef.maxSize ?? MAX_COLUMN_SIZE;
		const size = Math.min(maxSize, Math.max(minSize, Math.ceil(width)));
		currentTable.setColumnSizing((previous) => ({
			...previous,
			[columnId]: size,
		}));
	}, []);

	const onSearchOpenChange = useCallback(
		(open: boolean) => {
			if (open) {
				store.setState("searchOpen", true);
				return;
			}

			const currentState = store.getState();
			const currentMatch =
				currentState.matchIndex >= 0 &&
				currentState.searchMatches[currentState.matchIndex];

			store.batch(() => {
				store.setState("searchOpen", false);
				store.setState("searchQuery", "");
				store.setState("searchMatches", []);
				store.setState("matchIndex", -1);

				if (currentMatch) {
					store.setState("focusedCell", {
						rowIndex: currentMatch.rowIndex,
						columnId: currentMatch.columnId,
					});
				}
			});

			if (
				dataGridRef.current &&
				document.activeElement !== dataGridRef.current
			) {
				dataGridRef.current.focus();
			}
		},
		[store]
	);

	return {
		...gridContext,
		onCellsPasteTransposed,
		onColumnAutoFit,
		onFillSelection,
		onRedo,
		onRowsInsertAt,
		onSearchOpenChange,
		onUndo,
	};
}

type DataGridHistoryContext<TData> = ReturnType<
	typeof useDataGridHistory<TData>
>;

export { type DataGridHistoryContext, useDataGridHistory };
