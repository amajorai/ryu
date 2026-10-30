import {
	type ColumnSizeStyle,
	isGridStateUpdater,
	MAX_COLUMN_SIZE,
	MIN_COLUMN_SIZE,
	VIEWPORT_OFFSET,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import type { DataGridPointerContext } from "@ryu/ui/hooks/use-data-grid-pointer.ts";
import { getCellKey, scrollCellIntoView } from "@ryu/ui/lib/data-grid.ts";
import { matchesFilterKeys } from "@ryu/ui/lib/data-grid-fill.ts";
import type { RowHeightValue } from "@ryu/ui/types/data-grid.ts";
import {
	type ColumnDef,
	type ColumnFiltersState,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type RowSelectionState,
	type SortingState,
	type TableMeta,
	type TableOptions,
	type TableState,
	type Updater,
	useReactTable,
} from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

function useDataGridTable<TData>(gridContext: DataGridPointerContext<TData>) {
	const {
		cellMapRef,
		columnFilters,
		columnIds,
		columns,
		data,
		dataGridRef,
		dir,
		getIsActiveSearchMatch,
		getIsCellSelected,
		getIsSearchMatch,
		getVisualRowIndex,
		headerRef,
		onCellClick,
		onCellContextMenu,
		onCellDoubleClick,
		onCellEditingStart,
		onCellEditingStop,
		onCellMouseDown,
		onCellMouseEnter,
		onCellMouseUp,
		onCellsCopy,
		onCellsCut,
		onCellsPaste,
		onCellsPasteTransposed,
		onColumnAutoFit,
		onContextMenuOpenChange,
		onDataUpdate,
		onFillHandleDoubleClick,
		onFillHandleMouseDown,
		onFillSelection,
		onRedo,
		onRowsDelete,
		onRowsInsertAt,
		onSelectionClear,
		onUndo,
		propsRef,
		rowMapRef,
		rowSelection,
		rowVirtualizerRef,
		selectColumn,
		sorting,
		store,
		tableRef,
	} = gridContext;

	const onSortingChange = useCallback(
		(updater: Updater<SortingState>) => {
			const currentState = store.getState();
			const newSorting = isGridStateUpdater(updater)
				? updater(currentState.sorting)
				: updater;
			store.setState("sorting", newSorting);

			propsRef.current.onSortingChange?.(newSorting);
		},
		[store, propsRef]
	);

	const onColumnFiltersChange = useCallback(
		(updater: Updater<ColumnFiltersState>) => {
			const currentState = store.getState();
			const newColumnFilters = isGridStateUpdater(updater)
				? updater(currentState.columnFilters)
				: updater;
			store.setState("columnFilters", newColumnFilters);

			propsRef.current.onColumnFiltersChange?.(newColumnFilters);
		},
		[store, propsRef]
	);

	const onRowSelectionChange = useCallback(
		(updater: Updater<RowSelectionState>) => {
			const currentState = store.getState();
			const newRowSelection = isGridStateUpdater(updater)
				? updater(currentState.rowSelection)
				: updater;

			const selectedRows = Object.keys(newRowSelection).filter(
				(key) => newRowSelection[key]
			);

			const selectedCells = new Set<string>();
			const rows = tableRef.current?.getRowModel().rows ?? [];

			for (const rowId of selectedRows) {
				const rowIndex = rows.findIndex((r) => r.id === rowId);
				if (rowIndex === -1) {
					continue;
				}

				for (const columnId of columnIds) {
					selectedCells.add(getCellKey(rowIndex, columnId));
				}
			}

			store.batch(() => {
				store.setState("rowSelection", newRowSelection);
				store.setState("selectionState", {
					selectedCells,
					selectionRange: null,
					isSelecting: false,
				});
				store.setState("focusedCell", null);
				store.setState("editingCell", null);
			});

			propsRef.current.onRowSelectionChange?.(updater);
		},
		[store, columnIds, propsRef]
	);

	const onRowSelect = useCallback(
		(rowId: string, selected: boolean, shiftKey: boolean) => {
			const currentState = store.getState();
			const rows = tableRef.current?.getRowModel().rows ?? [];
			const currentRowIndex = rows.findIndex((r) => r.id === rowId);
			const currentRow = currentRowIndex >= 0 ? rows[currentRowIndex] : null;
			if (!currentRow) {
				return;
			}

			if (shiftKey && currentState.lastClickedRowId !== null) {
				const lastClickedRowIndex = rows.findIndex(
					(r) => r.id === currentState.lastClickedRowId
				);
				if (lastClickedRowIndex >= 0) {
					const startIndex = Math.min(lastClickedRowIndex, currentRowIndex);
					const endIndex = Math.max(lastClickedRowIndex, currentRowIndex);

					const newRowSelection: RowSelectionState = {
						...currentState.rowSelection,
					};

					for (let i = startIndex; i <= endIndex; i++) {
						const row = rows[i];
						if (row) {
							newRowSelection[row.id] = selected;
						}
					}

					onRowSelectionChange(newRowSelection);
				} else {
					onRowSelectionChange({
						...currentState.rowSelection,
						[currentRow.id]: selected,
					});
				}
			} else {
				onRowSelectionChange({
					...currentState.rowSelection,
					[currentRow.id]: selected,
				});
			}

			store.setState("lastClickedRowId", rowId);
		},
		[store, onRowSelectionChange]
	);

	const onRowHeightChange = useCallback(
		(updater: Updater<RowHeightValue>) => {
			const currentState = store.getState();
			const newRowHeight = isGridStateUpdater(updater)
				? updater(currentState.rowHeight)
				: updater;
			store.setState("rowHeight", newRowHeight);
			propsRef.current.onRowHeightChange?.(newRowHeight);
		},
		[store, propsRef]
	);

	const onColumnClick = useCallback(
		(columnId: string) => {
			if (!propsRef.current.enableColumnSelection) {
				onSelectionClear();
				return;
			}

			selectColumn(columnId);
		},
		[propsRef, selectColumn, onSelectionClear]
	);

	const onPasteDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				store.setState("pasteDialog", {
					open: false,
					rowsNeeded: 0,
					clipboardText: "",
				});
			}
		},
		[store]
	);

	const defaultColumn: Partial<ColumnDef<TData>> = useMemo(
		() => ({
			// Cell is rendered directly in DataGridRow to bypass flexRender's
			// unstable cell.getContext() (https://github.com/TanStack/table/issues/4794)
			minSize: MIN_COLUMN_SIZE,
			maxSize: MAX_COLUMN_SIZE,
			// Header AutoFilter: the filter value is the list of kept cell values.
			filterFn: (row, columnId, filterValue) =>
				matchesFilterKeys(row.getValue(columnId), filterValue),
		}),
		[]
	);

	const tableMeta = useMemo<TableMeta<TData>>(() => {
		return {
			...propsRef.current.meta,
			dataGridRef,
			cellMapRef,
			get focusedCell() {
				return store.getState().focusedCell;
			},
			get editingCell() {
				return store.getState().editingCell;
			},
			get selectionState() {
				return store.getState().selectionState;
			},
			get searchOpen() {
				return store.getState().searchOpen;
			},
			get contextMenu() {
				return store.getState().contextMenu;
			},
			get pasteDialog() {
				return store.getState().pasteDialog;
			},
			get rowHeight() {
				return store.getState().rowHeight;
			},
			get readOnly() {
				return propsRef.current.readOnly;
			},
			getIsCellSelected,
			getIsSearchMatch,
			getIsActiveSearchMatch,
			getVisualRowIndex,
			scrollToCell: (rowIndex, columnId, align = "auto") => {
				const container = dataGridRef.current;
				if (!container) {
					return;
				}

				rowVirtualizerRef.current?.scrollToIndex(rowIndex, { align });

				const scrollRowIntoView = (retries = 1) => {
					requestAnimationFrame(() => {
						const targetRow = rowMapRef.current.get(rowIndex);
						if (!targetRow) {
							if (retries > 0) {
								scrollRowIntoView(retries - 1);
							}
							return;
						}

						const headerBottom =
							headerRef.current?.getBoundingClientRect().bottom ??
							container.getBoundingClientRect().top;

						const viewportTop = headerBottom + VIEWPORT_OFFSET;

						const rowRect = targetRow.getBoundingClientRect();

						if (rowRect.top < viewportTop) {
							container.scrollTop -= viewportTop - rowRect.top;
						}

						const cellKey = getCellKey(rowIndex, columnId);
						const targetCell = cellMapRef.current.get(cellKey);
						if (targetCell) {
							scrollCellIntoView({
								container,
								targetCell,
								tableRef,
								viewportOffset: VIEWPORT_OFFSET,
								isRtl: dir === "rtl",
							});
						}
					});
				};

				scrollRowIntoView();
			},
			onRowHeightChange,
			onRowSelect,
			onDataUpdate,
			onRowsDelete: propsRef.current.onRowsDelete ? onRowsDelete : undefined,
			onColumnClick,
			onCellClick,
			onCellDoubleClick,
			onCellMouseDown,
			onCellMouseEnter,
			onCellMouseUp,
			onCellContextMenu,
			onCellEditingStart,
			onCellEditingStop,
			onCellsCopy,
			onCellsCut,
			onCellsPaste: propsRef.current.enablePaste ? onCellsPaste : undefined,
			onCellsPasteTransposed: propsRef.current.enablePaste
				? onCellsPasteTransposed
				: undefined,
			onColumnAutoFit,
			onFillHandleDoubleClick,
			onFillHandleMouseDown,
			onFillSelection,
			onRedo,
			onRowsInsert: propsRef.current.onRowsInsert ? onRowsInsertAt : undefined,
			onSelectionClear,
			onUndo,
			onFilesUpload: propsRef.current.onFilesUpload
				? propsRef.current.onFilesUpload
				: undefined,
			onFilesDelete: propsRef.current.onFilesDelete
				? propsRef.current.onFilesDelete
				: undefined,
			onContextMenuOpenChange,
			onPasteDialogOpenChange,
		};
	}, [
		propsRef,
		store,
		dir,
		getIsCellSelected,
		getIsSearchMatch,
		getIsActiveSearchMatch,
		getVisualRowIndex,
		onRowHeightChange,
		onRowSelect,
		onDataUpdate,
		onRowsDelete,
		onColumnClick,
		onCellClick,
		onCellDoubleClick,
		onCellMouseDown,
		onCellMouseEnter,
		onCellMouseUp,
		onCellContextMenu,
		onCellEditingStart,
		onCellEditingStop,
		onCellsCopy,
		onCellsCut,
		onCellsPaste,
		onCellsPasteTransposed,
		onColumnAutoFit,
		onFillHandleDoubleClick,
		onFillHandleMouseDown,
		onFillSelection,
		onRedo,
		onRowsInsertAt,
		onSelectionClear,
		onUndo,
		onContextMenuOpenChange,
		onPasteDialogOpenChange,
	]);

	const getMemoizedCoreRowModel = useMemo(() => getCoreRowModel(), []);
	const getMemoizedFilteredRowModel = useMemo(() => getFilteredRowModel(), []);
	const getMemoizedSortedRowModel = useMemo(() => getSortedRowModel(), []);

	// Memoize state object to reduce shallow equality checks
	const tableState = useMemo<Partial<TableState>>(
		() => ({
			...propsRef.current.state,
			sorting,
			columnFilters,
			rowSelection,
		}),
		[propsRef, sorting, columnFilters, rowSelection]
	);

	const tableOptions = useMemo<TableOptions<TData>>(() => {
		return {
			...propsRef.current,
			data,
			columns,
			defaultColumn,
			initialState: propsRef.current.initialState,
			state: tableState,
			onRowSelectionChange,
			onSortingChange,
			onColumnFiltersChange,
			columnResizeMode: "onChange",
			columnResizeDirection: dir,
			getCoreRowModel: getMemoizedCoreRowModel,
			getFilteredRowModel: getMemoizedFilteredRowModel,
			getSortedRowModel: getMemoizedSortedRowModel,
			meta: tableMeta,
		};
	}, [
		propsRef,
		data,
		columns,
		defaultColumn,
		tableState,
		dir,
		onRowSelectionChange,
		onSortingChange,
		onColumnFiltersChange,
		getMemoizedCoreRowModel,
		getMemoizedFilteredRowModel,
		getMemoizedSortedRowModel,
		tableMeta,
	]);

	const table = useReactTable(tableOptions);

	if (!tableRef.current) {
		tableRef.current = table;
	}

	const columnSizeVars = useMemo(() => {
		const headers = table.getFlatHeaders();
		const colSizes: ColumnSizeStyle = {};
		for (const header of headers) {
			colSizes[`--header-${header.id}-size`] = header.getSize();
			colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
		}
		return colSizes;
		// `columns` matters too: a consumer that renders before its columns load
		// (Spaces) would otherwise keep width variables for no columns, leaving
		// every cell content-sized and out of line with its header.
	}, [
		table.getState().columnSizingInfo,
		table.getState().columnSizing,
		columns,
	]);

	return { ...gridContext, columnSizeVars, table, tableMeta };
}

type DataGridTableContext<TData> = ReturnType<typeof useDataGridTable<TData>>;

export { type DataGridTableContext, useDataGridTable };
