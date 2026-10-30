import { useDirection } from "@ryu/ui/components/direction.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import {
	type CellChange,
	type DataGridState,
	type DataGridStore,
	DEFAULT_ROW_HEIGHT,
	gridColumnIdSchema,
	HISTORY_LIMIT,
	type HistoryEntry,
	NON_NAVIGABLE_COLUMN_IDS,
	OVERSCAN,
	type UseDataGridProps,
	useStore,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { useLazyRef } from "@ryu/ui/hooks/use-lazy-ref.ts";
import {
	getCellKey,
	getRowHeightValue,
	parseCellKey,
} from "@ryu/ui/lib/data-grid.ts";
import { type GridRect, isSameCellValue } from "@ryu/ui/lib/data-grid-fill.ts";
import type { CellPosition, CellUpdate } from "@ryu/ui/types/data-grid.ts";
import type { Row, useReactTable } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef } from "react";

function useDataGridState<TData>({
	data,
	columns,
	rowHeight: rowHeightProp = DEFAULT_ROW_HEIGHT,
	overscan = OVERSCAN,
	dir: dirProp,
	initialState,
	...props
}: UseDataGridProps<TData>) {
	// Base UI's `useDirection()` reads the ambient direction (no override arg,
	// unlike Radix's); honour an explicit `dir` prop when provided.
	const ambientDir = useDirection();
	const dir = dirProp ?? ambientDir;
	const dataGridRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<ReturnType<typeof useReactTable<TData>>>(null);
	const rowVirtualizerRef = useRef<Virtualizer<HTMLDivElement, Element>>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const rowMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
	const cellMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
	const footerRef = useRef<HTMLDivElement>(null);
	const focusGuardRef = useRef(false);
	// TSV the last cut wrote; a paste only moves (clears) the cut cells while the
	// clipboard still holds it, like a spreadsheet dropping a superseded cut.
	const cutClipboardTextRef = useRef<string | null>(null);

	const propsRef = useAsRef({
		...props,
		data,
		columns,
		initialState,
	});

	const listenersRef = useLazyRef(() => new Set<() => void>());

	const stateRef = useLazyRef<DataGridState>(() => {
		return {
			sorting: initialState?.sorting ?? [],
			columnFilters: initialState?.columnFilters ?? [],
			rowHeight: rowHeightProp,
			rowSelection: initialState?.rowSelection ?? {},
			selectionState: {
				selectedCells: new Set(),
				selectionRange: null,
				isSelecting: false,
			},
			focusedCell: null,
			editingCell: null,
			fillDrag: null,
			cutCells: new Set(),
			contextMenu: {
				open: false,
				x: 0,
				y: 0,
			},
			searchQuery: "",
			searchMatches: [],
			matchIndex: -1,
			searchOpen: false,
			lastClickedRowId: null,
			pasteDialog: {
				open: false,
				rowsNeeded: 0,
				clipboardText: "",
			},
		};
	});

	const store = useMemo<DataGridStore>(() => {
		let isBatching = false;
		let pendingNotification = false;

		return {
			subscribe: (callback) => {
				listenersRef.current.add(callback);
				return () => listenersRef.current.delete(callback);
			},
			getState: () => stateRef.current,
			setState: (key, value) => {
				if (Object.is(stateRef.current[key], value)) {
					return;
				}
				stateRef.current[key] = value;

				if (isBatching) {
					pendingNotification = true;
				} else if (!pendingNotification) {
					pendingNotification = true;
					queueMicrotask(() => {
						pendingNotification = false;
						store.notify();
					});
				}
			},
			notify: () => {
				for (const listener of listenersRef.current) {
					listener();
				}
			},
			batch: (fn) => {
				if (isBatching) {
					fn();
					return;
				}

				isBatching = true;
				const wasPending = pendingNotification;
				pendingNotification = false;

				try {
					fn();
				} finally {
					isBatching = false;
					if (pendingNotification || wasPending) {
						pendingNotification = false;
						store.notify();
					}
				}
			},
		};
	}, [listenersRef, stateRef]);

	const focusedCell = useStore(store, (state) => state.focusedCell);
	const editingCell = useStore(store, (state) => state.editingCell);
	const selectionState = useStore(store, (state) => state.selectionState);
	const searchQuery = useStore(store, (state) => state.searchQuery);
	const searchMatches = useStore(store, (state) => state.searchMatches);
	const matchIndex = useStore(store, (state) => state.matchIndex);
	const searchOpen = useStore(store, (state) => state.searchOpen);
	const sorting = useStore(store, (state) => state.sorting);
	const columnFilters = useStore(store, (state) => state.columnFilters);
	const rowSelection = useStore(store, (state) => state.rowSelection);
	const rowHeight = useStore(store, (state) => state.rowHeight);
	const contextMenu = useStore(store, (state) => state.contextMenu);
	const pasteDialog = useStore(store, (state) => state.pasteDialog);

	const rowHeightValue = getRowHeightValue(rowHeight);

	const prevCellSelectionMapRef = useLazyRef(
		() => new Map<number, Set<string>>()
	);

	// Memoize per-row selection sets to prevent unnecessary row re-renders
	// Each row gets a stable Set reference that only changes when its cells' selection changes
	const cellSelectionMap = useMemo(() => {
		const selectedCells = selectionState.selectedCells;

		if (selectedCells.size === 0) {
			prevCellSelectionMapRef.current.clear();
			return null;
		}

		const newRowCells = new Map<number, Set<string>>();
		for (const cellKey of selectedCells) {
			const { rowIndex } = parseCellKey(cellKey);
			let rowSet = newRowCells.get(rowIndex);
			if (!rowSet) {
				rowSet = new Set<string>();
				newRowCells.set(rowIndex, rowSet);
			}
			rowSet.add(cellKey);
		}

		const stableMap = new Map<number, Set<string>>();
		for (const [rowIndex, newSet] of newRowCells) {
			const prevSet = prevCellSelectionMapRef.current.get(rowIndex);
			if (
				prevSet &&
				prevSet.size === newSet.size &&
				[...newSet].every((key) => prevSet.has(key))
			) {
				stableMap.set(rowIndex, prevSet);
			} else {
				stableMap.set(rowIndex, newSet);
			}
		}

		prevCellSelectionMapRef.current = stableMap;
		return stableMap;
	}, [selectionState.selectedCells, prevCellSelectionMapRef]);

	const visualRowIndexCacheRef = useRef<{
		rows: Row<TData>[] | null;
		map: Map<string, number>;
	} | null>(null);

	// Pre-compute visual row index map for O(1) lookups (used by select column)
	// Cache is invalidated when row model identity changes (sorting/filtering)
	const getVisualRowIndex = useCallback((rowId: string): number | undefined => {
		const rows = tableRef.current?.getRowModel().rows;
		if (!rows) {
			return undefined;
		}

		if (visualRowIndexCacheRef.current?.rows !== rows) {
			const map = new Map<string, number>();
			for (const [i, row] of rows.entries()) {
				map.set(row.id, i + 1);
			}
			visualRowIndexCacheRef.current = { rows, map };
		}

		return visualRowIndexCacheRef.current.map.get(rowId);
	}, []);

	const columnIds = useMemo(() => {
		return columns
			.map((c) => {
				if (c.id) {
					return c.id;
				}
				if ("accessorKey" in c) {
					const parsed = gridColumnIdSchema.safeParse(c.accessorKey);
					return parsed.success ? parsed.data : undefined;
				}
				return undefined;
			})
			.filter((id): id is string => Boolean(id));
	}, [columns]);

	const navigableColumnIds = useMemo(() => {
		return columnIds.filter((c) => !NON_NAVIGABLE_COLUMN_IDS.has(c));
	}, [columnIds]);

	const historyRef = useLazyRef<{
		redo: HistoryEntry<TData>[];
		undo: HistoryEntry<TData>[];
	}>(() => ({ undo: [], redo: [] }));

	const pushHistory = useCallback(
		(entry: HistoryEntry<TData>) => {
			const history = historyRef.current;
			history.undo.push(entry);
			if (history.undo.length > HISTORY_LIMIT) {
				history.undo.shift();
			}
			history.redo = [];
		},
		[historyRef]
	);

	const applyDataUpdate = useCallback(
		(updates: CellUpdate | CellUpdate[], recordHistory: boolean) => {
			if (propsRef.current.readOnly) {
				return;
			}

			const currentTable = tableRef.current;
			// Formula columns are computed, never written (paste, fill, clear...).
			const updateArray = (Array.isArray(updates) ? updates : [updates]).filter(
				(update) =>
					currentTable?.getColumn(update.columnId)?.columnDef.meta?.cell
						?.variant !== "formula"
			);

			if (updateArray.length === 0) {
				return;
			}

			const currentData = propsRef.current.data;
			const rows = currentTable?.getRowModel().rows;

			if (recordHistory && rows) {
				const changes: CellChange[] = [];
				for (const update of updateArray) {
					const row = rows[update.rowIndex];
					if (!row) {
						continue;
					}
					const before = row.getValue(update.columnId);
					if (!isSameCellValue(before, update.value)) {
						changes.push({
							rowId: row.id,
							columnId: update.columnId,
							before,
							after: update.value,
						});
					}
				}
				if (changes.length > 0) {
					pushHistory({ kind: "cells", changes });
				}
			}

			const rowUpdatesMap = new Map<number, Omit<CellUpdate, "rowIndex">[]>();

			for (const update of updateArray) {
				if (rows && currentTable) {
					const row = rows[update.rowIndex];
					if (!row) {
						continue;
					}

					const originalData = row.original;
					const originalRowIndex = currentData.indexOf(originalData);

					const targetIndex =
						originalRowIndex === -1 ? update.rowIndex : originalRowIndex;

					const existingUpdates = rowUpdatesMap.get(targetIndex) ?? [];
					existingUpdates.push({
						columnId: update.columnId,
						value: update.value,
					});
					rowUpdatesMap.set(targetIndex, existingUpdates);
				} else {
					const existingUpdates = rowUpdatesMap.get(update.rowIndex) ?? [];
					existingUpdates.push({
						columnId: update.columnId,
						value: update.value,
					});
					rowUpdatesMap.set(update.rowIndex, existingUpdates);
				}
			}

			const maxUpdateIndex =
				rowUpdatesMap.size > 0
					? Math.max(...Array.from(rowUpdatesMap.keys()))
					: -1;
			const dataLength = Math.max(currentData.length, maxUpdateIndex + 1);

			const newData: TData[] = [];
			newData.length = dataLength;

			for (let i = 0; i < dataLength; i++) {
				const updates = rowUpdatesMap.get(i);
				// Fall back to the table's row data for rows not yet in currentData
				const existingRow = currentData[i] ?? rows?.[i]?.original;

				if (existingRow == null) {
					continue;
				}

				if (updates) {
					const updatedRow = { ...existingRow };
					for (const { columnId, value } of updates) {
						Reflect.set(updatedRow, columnId, value);
					}
					newData[i] = updatedRow;
				} else {
					newData[i] = existingRow;
				}
			}

			propsRef.current.onDataChange?.(newData);
		},
		[propsRef, pushHistory]
	);

	// Ctrl+Enter while editing a multi-cell selection: the editor's commit is
	// held back and written to every selected cell as one undo step.
	const fillOnCommitRef = useRef<{ cell: CellPosition; rect: GridRect } | null>(
		null
	);
	const committedValueRef = useRef<{ value: unknown } | null>(null);

	const onDataUpdate = useCallback(
		(updates: CellUpdate | CellUpdate[]) => {
			const pending = fillOnCommitRef.current;
			const only = Array.isArray(updates)
				? updates.length === 1
					? updates[0]
					: undefined
				: updates;
			if (
				pending &&
				only &&
				only.rowIndex === pending.cell.rowIndex &&
				only.columnId === pending.cell.columnId
			) {
				committedValueRef.current = { value: only.value };
				return;
			}
			applyDataUpdate(updates, true);
		},
		[applyDataUpdate]
	);

	const getIsCellSelected = useCallback(
		(rowIndex: number, columnId: string) => {
			const currentSelectionState = store.getState().selectionState;
			return currentSelectionState.selectedCells.has(
				getCellKey(rowIndex, columnId)
			);
		},
		[store]
	);

	const onSelectionClear = useCallback(() => {
		store.batch(() => {
			store.setState("selectionState", {
				selectedCells: new Set(),
				selectionRange: null,
				isSelecting: false,
			});
			store.setState("rowSelection", {});
		});
	}, [store]);

	return {
		applyDataUpdate,
		cellMapRef,
		cellSelectionMap,
		columnFilters,
		columnIds,
		columns,
		committedValueRef,
		contextMenu,
		cutClipboardTextRef,
		data,
		dataGridRef,
		dir,
		editingCell,
		fillOnCommitRef,
		focusGuardRef,
		focusedCell,
		footerRef,
		getIsCellSelected,
		getVisualRowIndex,
		headerRef,
		historyRef,
		matchIndex,
		navigableColumnIds,
		onDataUpdate,
		onSelectionClear,
		overscan,
		pasteDialog,
		propsRef,
		pushHistory,
		rowHeight,
		rowHeightValue,
		rowMapRef,
		rowSelection,
		rowVirtualizerRef,
		searchMatches,
		searchOpen,
		searchQuery,
		selectionState,
		sorting,
		store,
		tableRef,
	};
}

type DataGridStateContext<TData> = ReturnType<typeof useDataGridState<TData>>;

export { type DataGridStateContext, useDataGridState };
