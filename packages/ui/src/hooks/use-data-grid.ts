import { useDirection } from "@ryu/ui/components/direction.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { useIsomorphicLayoutEffect } from "@ryu/ui/hooks/use-isomorphic-layout-effect.ts";
import { useLazyRef } from "@ryu/ui/hooks/use-lazy-ref.ts";
import {
	formatDateToString,
	getCellKey,
	getEmptyCellValue,
	getIsInPopover,
	getRowHeightValue,
	getScrollDirection,
	matchSelectOption,
	parseCellKey,
	parsePastedDate,
	parseTsv,
	scrollCellIntoView,
} from "@ryu/ui/lib/data-grid.ts";
import {
	clipboardFileEntriesSchema,
	clipboardStringListSchema,
	clipboardTextValueSchema,
	describeClipboardTextValue,
	isCutOnClipboard,
	normalizeClipboardText,
} from "@ryu/ui/lib/data-grid-clipboard.ts";
import {
	buildFillSeries,
	type FillExtension,
	findDataEdge,
	type GridRect,
	getCellDisplayText,
	getFillExtension,
	getFilledRect,
	isCellValueEmpty,
	isSameCellValue,
	matchesFilterKeys,
	repeatPattern,
	type SelectionSummary,
	serializeTsv,
	summarizeValues,
	transposeMatrix,
} from "@ryu/ui/lib/data-grid-fill.ts";
import type {
	CellOpts,
	CellPosition,
	CellUpdate,
	ContextMenuState,
	Direction,
	FileCellData,
	NavigationDirection,
	PasteDialogState,
	RowHeightValue,
	SearchState,
	SelectionState,
} from "@ryu/ui/types/data-grid.ts";
import {
	type ColumnDef,
	type ColumnFiltersState,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type Row,
	type RowSelectionState,
	type SortingState,
	type TableMeta,
	type TableOptions,
	type TableState,
	type Updater,
	useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { z } from "zod";

const nativeUpdaterSchema = z.function();
// TanStack accessor keys admit numeric object keys; DOM/navigation identities
// are strings. Retain the existing falsy-key omission while normalizing numbers.
const gridColumnIdSchema = z
	.union([
		z.string(),
		z.number(),
		z.nan(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
	])
	.transform((key) => (key ? String(key) : undefined));
const gridEventNodeSchema = z.custom<Node>((value) => value instanceof Node);

/** Values produced by the grid clipboard conversion for its declared cell variants. */
type ClipboardCellValue =
	| string
	| number
	| boolean
	| Date
	| string[]
	| FileCellData[]
	| null;

function isGridStateUpdater<T>(
	updater: Updater<T>
): updater is (previous: T) => T {
	return nativeUpdaterSchema.safeParse(updater).success;
}
function isGridEventInside(
	container: HTMLElement,
	target: EventTarget | null
): boolean {
	const parsed = gridEventNodeSchema.safeParse(target);
	return parsed.success && container.contains(parsed.data);
}

const DEFAULT_ROW_HEIGHT = "short";
const OVERSCAN = 6;
const VIEWPORT_OFFSET = 1;
const HORIZONTAL_PAGE_SIZE = 5;
const SCROLL_SYNC_RETRY_COUNT = 16;
const MIN_COLUMN_SIZE = 60;
const MAX_COLUMN_SIZE = 800;
const SEARCH_SHORTCUT_KEY = "f";
const NON_NAVIGABLE_COLUMN_IDS = new Set(["select", "actions"]);
const AUTO_SCROLL_EDGE_ZONE = 50;
const AUTO_SCROLL_SPEED_RAMP_ZONE = AUTO_SCROLL_EDGE_ZONE * 3;
const AUTO_SCROLL_MIN_SPEED = 8;
const AUTO_SCROLL_MAX_SPEED = 40;
const AUTO_SCROLL_SELECTION_THROTTLE_MS = 32;
const HISTORY_LIMIT = 100;
const AUTO_FIT_ROW_LIMIT = 5000;
const AUTO_FIT_HEADER_CHROME = 56;
const AUTO_FIT_CELL_PADDING = 20;
const AUTO_FIT_CHIP_PADDING = 20;

const DOMAIN_REGEX = /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}.*)?$/;
const TRUTHY_BOOLEANS = new Set(["true", "1", "yes", "checked"]);
const VALID_BOOLEANS = new Set([
	"true",
	"false",
	"1",
	"0",
	"yes",
	"no",
	"checked",
	"unchecked",
]);

interface FillDragState {
	end: CellPosition;
	source: GridRect;
}

interface CellChange {
	after: unknown;
	before: unknown;
	columnId: string;
	rowId: string;
}

/** A row as it was when removed (or inserted), addressed by stable row id. */
interface RowSnapshot<TData> {
	dataIndex: number;
	original: TData | null;
	rowId: string;
}

/** One undoable action: cell edits, rows removed/inserted, or several as one step. */
type HistoryEntry<TData> =
	| { kind: "cells"; changes: CellChange[] }
	| { kind: "rows-removed" | "rows-inserted"; rows: RowSnapshot<TData>[] }
	| { kind: "group"; entries: HistoryEntry<TData>[] };

/** Resolve the selection's rectangle in navigable-column space, if it is one. */
function getSelectionRect(params: {
	columnIds: string[];
	focusedCell: CellPosition | null;
	navigableColumnIds: string[];
	selectionState: SelectionState;
}): GridRect | null {
	const { columnIds, focusedCell, navigableColumnIds, selectionState } = params;
	const range = selectionState.selectionRange;
	let start: CellPosition;
	let end: CellPosition;

	// A single (or no) selected cell follows the focused cell: keyboard
	// navigation moves focus without rewriting the last mouse range.
	if (selectionState.selectedCells.size <= 1) {
		if (!focusedCell) {
			return null;
		}
		start = focusedCell;
		end = focusedCell;
	} else if (range) {
		start = range.start;
		end = range.end;
	} else {
		return null;
	}

	const startIndex = columnIds.indexOf(start.columnId);
	const endIndex = columnIds.indexOf(end.columnId);
	if (startIndex === -1 || endIndex === -1) {
		return null;
	}
	const spanned = columnIds
		.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
		.filter((id) => !NON_NAVIGABLE_COLUMN_IDS.has(id));
	const first = spanned[0];
	const last = spanned.at(-1);
	if (!(first && last)) {
		return null;
	}
	return {
		minRow: Math.min(start.rowIndex, end.rowIndex),
		maxRow: Math.max(start.rowIndex, end.rowIndex),
		minCol: navigableColumnIds.indexOf(first),
		maxCol: navigableColumnIds.indexOf(last),
	};
}

/** Whether `value` can be written into a column configured as `cellOpts`. */
function isFillValueCompatible<CellValue>(
	value: CellValue,
	cellOpts?: CellOpts
): boolean {
	if (cellOpts?.variant === "select") {
		return value === null || cellOpts.options.some((o) => o.value === value);
	}
	if (cellOpts?.variant === "multi-select") {
		return (
			Array.isArray(value) &&
			value.every((v) => cellOpts.options.some((o) => o.value === v))
		);
	}
	return true;
}

interface ColumnSizeStyle extends React.CSSProperties {
	[headerSize: `--header-${string}-size`]: number;
	[columnSize: `--col-${string}-size`]: number;
}

interface DataGridState {
	columnFilters: ColumnFiltersState;
	contextMenu: ContextMenuState;
	cutCells: Set<string>;
	editingCell: CellPosition | null;
	fillDrag: FillDragState | null;
	focusedCell: CellPosition | null;
	lastClickedRowId: string | null;
	matchIndex: number;
	pasteDialog: PasteDialogState;
	rowHeight: RowHeightValue;
	rowSelection: RowSelectionState;
	searchMatches: CellPosition[];
	searchOpen: boolean;
	searchQuery: string;
	selectionState: SelectionState;
	sorting: SortingState;
}

interface DataGridStore {
	batch: (fn: () => void) => void;
	getState: () => DataGridState;
	notify: () => void;
	setState: <K extends keyof DataGridState>(
		key: K,
		value: DataGridState[K]
	) => void;
	subscribe: (callback: () => void) => () => void;
}

function useStore<T>(
	store: DataGridStore,
	selector: (state: DataGridState) => T
): T {
	const getSnapshot = useCallback(
		() => selector(store.getState()),
		[store, selector]
	);

	return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

interface UseDataGridProps<TData>
	extends Omit<TableOptions<TData>, "pageCount" | "getCoreRowModel"> {
	autoFocus?: boolean | Partial<CellPosition>;
	dir?: Direction;
	enableColumnSelection?: boolean;
	enablePaste?: boolean;
	enableSearch?: boolean;
	/** Show a status bar with row count and Count/Sum/Average/Min/Max of the selection. */
	enableSelectionSummary?: boolean;
	enableSingleCellSelection?: boolean;
	onDataChange?: (data: TData[]) => void;
	onFilesDelete?: (params: {
		fileIds: string[];
		rowIndex: number;
		columnId: string;
	}) => void | Promise<void>;
	onFilesUpload?: (params: {
		files: File[];
		rowIndex: number;
		columnId: string;
	}) => Promise<FileCellData[]>;
	onPaste?: (updates: CellUpdate[]) => void | Promise<void>;
	onRowAdd?: (
		event?: MouseEvent<HTMLDivElement>
	) => Partial<CellPosition> | Promise<Partial<CellPosition> | null> | null;
	onRowHeightChange?: (rowHeight: RowHeightValue) => void;
	onRowsAdd?: (count: number) => void | Promise<void>;
	/** Delete `rows`; `rowIndices` are their indices in `data`. */
	onRowsDelete?: (rows: TData[], rowIndices: number[]) => void | Promise<void>;
	/**
	 * Insert `count` rows at `index` in `data` (Insert row above/below,
	 * Duplicate rows, and undo of a delete). Without `source` the rows are
	 * empty; with it they copy `source` — keeping each row's identity when
	 * `restore` is set, otherwise as new rows. Return the inserted rows' ids
	 * (as `getRowId` reports them) to make the insert undoable.
	 */
	onRowsInsert?: (params: {
		count: number;
		index: number;
		restore?: boolean;
		source?: TData[];
	}) => string[] | undefined | Promise<string[] | undefined>;
	overscan?: number;
	readOnly?: boolean;
	rowHeight?: RowHeightValue;
}

function useDataGrid<TData>({
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
				`${selectedCellsArray.length} cell${
					selectedCellsArray.length === 1 ? "" : "s"
				} copied`
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to copy to clipboard"
			);
		}
	}, [store, serializeCellsToTsv]);

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
				`${selectedCellsArray.length} cell${
					selectedCellsArray.length === 1 ? "" : "s"
				} cut`
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to cut to clipboard"
			);
		}
	}, [store, propsRef, serializeCellsToTsv]);

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
						const cellVariant = cellOpts?.variant;

						let processedValue: ClipboardCellValue = pastedValue;
						let shouldSkip = false;

						switch (cellVariant) {
							case "formula": {
								// Formula columns are computed and never written.
								shouldSkip = true;
								break;
							}

							case "number": {
								if (pastedValue) {
									const num = Number.parseFloat(pastedValue);
									if (Number.isNaN(num)) {
										shouldSkip = true;
									} else {
										processedValue = num;
									}
								} else {
									processedValue = null;
								}
								break;
							}

							case "checkbox": {
								if (pastedValue) {
									const lower = pastedValue.toLowerCase();
									if (VALID_BOOLEANS.has(lower)) {
										processedValue = TRUTHY_BOOLEANS.has(lower);
									} else {
										shouldSkip = true;
									}
								} else {
									processedValue = false;
								}
								break;
							}

							case "date": {
								if (pastedValue) {
									const date = parsePastedDate(pastedValue);
									if (date === null) {
										shouldSkip = true;
									} else {
										processedValue = date;
									}
								} else {
									processedValue = null;
								}
								break;
							}

							case "select": {
								const options = cellOpts?.options ?? [];
								if (pastedValue) {
									const matched = matchSelectOption(pastedValue, options);
									if (matched) {
										processedValue = matched;
									} else {
										shouldSkip = true;
									}
								} else {
									processedValue = null;
								}
								break;
							}

							case "multi-select": {
								const options = cellOpts?.options ?? [];
								let values: string[] = [];
								try {
									const parsed = clipboardStringListSchema.safeParse(
										JSON.parse(pastedValue)
									);
									if (parsed.success) {
										values = parsed.data;
									}
								} catch {
									values = pastedValue
										? pastedValue.split(",").map((v) => v.trim())
										: [];
								}

								const validated = values
									.map((v) => matchSelectOption(v, options))
									.filter((value): value is string => Boolean(value));

								if (values.length > 0 && validated.length === 0) {
									shouldSkip = true;
								} else {
									processedValue = validated;
								}
								break;
							}

							case "file": {
								if (pastedValue) {
									try {
										const parsed = clipboardFileEntriesSchema.safeParse(
											JSON.parse(pastedValue)
										);
										if (parsed.success) {
											const validFiles = parsed.data.filter(
												(file): file is FileCellData => file !== undefined
											);
											if (parsed.data.length > 0 && validFiles.length === 0) {
												shouldSkip = true;
											} else {
												processedValue = validFiles;
											}
										} else {
											shouldSkip = true;
										}
									} catch {
										shouldSkip = true;
									}
								} else {
									processedValue = [];
								}
								break;
							}

							case "url": {
								if (pastedValue) {
									const firstChar = pastedValue[0];
									if (firstChar === "[" || firstChar === "{") {
										shouldSkip = true;
									} else {
										try {
											new URL(pastedValue);
											processedValue = pastedValue;
										} catch {
											if (DOMAIN_REGEX.test(pastedValue)) {
												processedValue = pastedValue;
											} else {
												shouldSkip = true;
											}
										}
									}
								} else {
									processedValue = "";
								}
								break;
							}

							default: {
								if (!pastedValue) {
									processedValue = "";
									break;
								}

								if (ISO_DATE_REGEX.test(pastedValue)) {
									const date = new Date(pastedValue);
									if (!Number.isNaN(date.getTime())) {
										processedValue = date.toLocaleDateString();
										break;
									}
								}

								const firstChar = pastedValue[0];
								if (
									firstChar === "[" ||
									firstChar === "{" ||
									firstChar === "t" ||
									firstChar === "f"
								) {
									try {
										const parsed = clipboardTextValueSchema.safeParse(
											JSON.parse(pastedValue)
										);
										if (parsed.success) {
											processedValue = describeClipboardTextValue(parsed.data);
										}
									} catch {
										const lower = pastedValue.toLowerCase();
										if (lower === "true" || lower === "false") {
											processedValue =
												lower === "true" ? "Checked" : "Unchecked";
										}
									}
								}
							}
						}

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
							`${cellsUpdated} cell${
								cellsUpdated === 1 ? "" : "s"
							} pasted, ${cellsSkipped} skipped`
						);
					} else {
						toast.success(
							`${cellsUpdated} cell${cellsUpdated === 1 ? "" : "s"} pasted`
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
						`${cellsSkipped} cell${
							cellsSkipped === 1 ? "" : "s"
						} skipped pasting for invalid data`
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

	const onCellEditingStart = useCallback(
		(rowIndex: number, columnId: string) => {
			if (propsRef.current.readOnly) {
				return;
			}

			const variant =
				tableRef.current?.getColumn(columnId)?.columnDef.meta?.cell?.variant;
			if (variant === "formula") {
				return;
			}

			fillOnCommitRef.current = null;
			committedValueRef.current = null;
			store.batch(() => {
				store.setState("focusedCell", { rowIndex, columnId });
				store.setState("editingCell", { rowIndex, columnId });
			});
		},
		[store, propsRef]
	);

	const onCellEditingStop = useCallback(
		(opts?: { moveToNextRow?: boolean; direction?: NavigationDirection }) => {
			const currentState = store.getState();
			const currentEditing = currentState.editingCell;
			const pendingFill = fillOnCommitRef.current;
			const committed = committedValueRef.current;
			fillOnCommitRef.current = null;
			committedValueRef.current = null;

			store.setState("editingCell", null);

			if (
				pendingFill &&
				currentEditing &&
				pendingFill.cell.rowIndex === currentEditing.rowIndex &&
				pendingFill.cell.columnId === currentEditing.columnId
			) {
				const { rowIndex, columnId } = currentEditing;
				const currentTable = tableRef.current;
				const value = committed
					? committed.value
					: currentTable?.getRowModel().rows[rowIndex]?.getValue(columnId);
				const getCellOpts = (id: string) =>
					currentTable?.getColumn(id)?.columnDef.meta?.cell;
				const sourceVariant = getCellOpts(columnId)?.variant;
				const { rect } = pendingFill;
				const updates: CellUpdate[] = [];
				for (let col = rect.minCol; col <= rect.maxCol; col++) {
					const id = navigableColumnIds[col];
					const targetOpts = id ? getCellOpts(id) : undefined;
					if (
						!id ||
						targetOpts?.variant !== sourceVariant ||
						!isFillValueCompatible(value, targetOpts)
					) {
						continue;
					}
					for (let row = rect.minRow; row <= rect.maxRow; row++) {
						updates.push({
							rowIndex: row,
							columnId: id,
							value: repeatPattern([value], 1)[0],
						});
					}
				}
				applyDataUpdate(updates, true);
				focusCellWrapper(rowIndex, columnId);
				return;
			}

			if (opts?.moveToNextRow && currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				const currentTable = tableRef.current;
				const rows = currentTable?.getRowModel().rows ?? [];
				const rowCount = rows.length ?? propsRef.current.data.length;

				const nextRowIndex = rowIndex + 1;
				if (nextRowIndex < rowCount) {
					requestAnimationFrame(() => {
						focusCell(nextRowIndex, columnId);
					});
				}
			} else if (opts?.direction && currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				focusCell(rowIndex, columnId);
				requestAnimationFrame(() => {
					navigateCell(opts.direction ?? "right");
				});
			} else if (currentEditing) {
				const { rowIndex, columnId } = currentEditing;
				focusCellWrapper(rowIndex, columnId);
			}
		},
		[
			store,
			propsRef,
			focusCell,
			navigateCell,
			focusCellWrapper,
			navigableColumnIds,
			applyDataUpdate,
		]
	);

	const getCurrentSelectionRect = useCallback(() => {
		const currentState = store.getState();
		return getSelectionRect({
			columnIds,
			focusedCell: currentState.focusedCell,
			navigableColumnIds,
			selectionState: currentState.selectionState,
		});
	}, [store, columnIds, navigableColumnIds]);

	const selectRect = useCallback(
		(rect: GridRect) => {
			const startColumnId = navigableColumnIds[rect.minCol];
			const endColumnId = navigableColumnIds[rect.maxCol];
			if (!(startColumnId && endColumnId)) {
				return;
			}
			const start = { rowIndex: rect.minRow, columnId: startColumnId };
			if (rect.minRow === rect.maxRow && rect.minCol === rect.maxCol) {
				store.setState("selectionState", {
					selectedCells: new Set(),
					selectionRange: { start, end: start },
					isSelecting: false,
				});
				return;
			}
			selectRange(start, { rowIndex: rect.maxRow, columnId: endColumnId });
		},
		[store, navigableColumnIds, selectRange]
	);

	/**
	 * Extend `source` by `extension`, either continuing its series (fill handle)
	 * or repeating it verbatim (Ctrl+D / Ctrl+R). Returns the filled rectangle,
	 * or null when nothing was written.
	 */
	const applyFill = useCallback(
		(
			source: GridRect,
			extension: FillExtension,
			mode: "series" | "copy"
		): GridRect | null => {
			const currentTable = tableRef.current;
			if (propsRef.current.readOnly || !currentTable) {
				return null;
			}
			const rows = currentTable.getRowModel().rows;
			const { direction } = extension;
			const room =
				direction === "down"
					? rows.length - 1 - source.maxRow
					: direction === "up"
						? source.minRow
						: direction === "right"
							? navigableColumnIds.length - 1 - source.maxCol
							: source.minCol;
			const count = Math.min(extension.count, room);
			if (count <= 0) {
				return null;
			}

			const getCellOpts = (columnId: string) =>
				currentTable.getColumn(columnId)?.columnDef.meta?.cell;
			const reverse = direction === "up" || direction === "left";
			const extend = (values: unknown[], cellOpts?: CellOpts) => {
				const ordered = reverse ? [...values].reverse() : values;
				return mode === "copy"
					? repeatPattern(ordered, count)
					: buildFillSeries(ordered, count, cellOpts, reverse);
			};
			const updates: CellUpdate[] = [];

			if (direction === "down" || direction === "up") {
				for (let col = source.minCol; col <= source.maxCol; col++) {
					const columnId = navigableColumnIds[col];
					if (!columnId) {
						continue;
					}
					const values: unknown[] = [];
					for (let row = source.minRow; row <= source.maxRow; row++) {
						values.push(rows[row]?.getValue(columnId));
					}
					for (const [i, value] of extend(
						values,
						getCellOpts(columnId)
					).entries()) {
						updates.push({
							rowIndex: reverse ? source.minRow - 1 - i : source.maxRow + 1 + i,
							columnId,
							value,
						});
					}
				}
			} else {
				const width = source.maxCol - source.minCol + 1;
				const sourceIds = navigableColumnIds.slice(
					source.minCol,
					source.maxCol + 1
				);
				const sourceOpts = sourceIds.map(getCellOpts);
				const firstVariant = sourceOpts[0]?.variant;
				const sharedOpts = sourceOpts.every((o) => o?.variant === firstVariant)
					? sourceOpts[0]
					: { variant: "checkbox" as const };

				for (let row = source.minRow; row <= source.maxRow; row++) {
					const values = sourceIds.map((id) => rows[row]?.getValue(id));
					for (const [i, value] of extend(values, sharedOpts).entries()) {
						const col = reverse ? source.minCol - 1 - i : source.maxCol + 1 + i;
						const columnId = navigableColumnIds[col];
						if (!columnId) {
							continue;
						}
						// Horizontal fills cross column types; only write where the target
						// column has the same type (and options) as the cell it copies.
						const patternIndex = reverse ? width - 1 - (i % width) : i % width;
						const targetOpts = getCellOpts(columnId);
						if (
							targetOpts?.variant !== sourceOpts[patternIndex]?.variant ||
							!isFillValueCompatible(value, targetOpts)
						) {
							continue;
						}
						updates.push({ rowIndex: row, columnId, value });
					}
				}
			}

			if (updates.length === 0) {
				return null;
			}
			onDataUpdate(updates);
			return getFilledRect(source, { direction, count });
		},
		[propsRef, navigableColumnIds, onDataUpdate]
	);

	const updateFillDrag = useCallback(
		(target: CellPosition) => {
			const { fillDrag } = store.getState();
			if (
				!fillDrag ||
				(fillDrag.end.rowIndex === target.rowIndex &&
					fillDrag.end.columnId === target.columnId)
			) {
				return;
			}
			store.setState("fillDrag", { ...fillDrag, end: target });
			const col = navigableColumnIds.indexOf(target.columnId);
			const extension = getFillExtension(fillDrag.source, {
				row: target.rowIndex,
				col: col === -1 ? fillDrag.source.minCol : col,
			});
			selectRect(
				extension ? getFilledRect(fillDrag.source, extension) : fillDrag.source
			);
		},
		[store, navigableColumnIds, selectRect]
	);
	const fillDragDepsRef = useAsRef({ updateFillDrag });

	const commitFillDrag = useCallback(() => {
		const { fillDrag } = store.getState();
		if (!fillDrag) {
			return;
		}
		store.setState("fillDrag", null);
		const col = navigableColumnIds.indexOf(fillDrag.end.columnId);
		const extension = getFillExtension(fillDrag.source, {
			row: fillDrag.end.rowIndex,
			col: col === -1 ? fillDrag.source.minCol : col,
		});
		const filled = extension
			? applyFill(fillDrag.source, extension, "series")
			: null;
		selectRect(filled ?? fillDrag.source);
		restoreFocus(dataGridRef.current);
	}, [store, navigableColumnIds, applyFill, selectRect, restoreFocus]);

	const onFillHandleMouseDown = useCallback(
		(event: MouseEvent) => {
			if (event.button !== 0 || propsRef.current.readOnly) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const source = getCurrentSelectionRect();
			const endColumnId = source && navigableColumnIds[source.maxCol];
			if (!(source && endColumnId)) {
				return;
			}
			store.setState("fillDrag", {
				source,
				end: { rowIndex: source.maxRow, columnId: endColumnId },
			});
			function onMouseUp() {
				document.removeEventListener("mouseup", onMouseUp);
				commitFillDrag();
			}
			document.addEventListener("mouseup", onMouseUp);
		},
		[
			propsRef,
			store,
			navigableColumnIds,
			getCurrentSelectionRect,
			commitFillDrag,
		]
	);

	// Excel's double-click on the fill handle: fill down as far as the adjacent
	// column's data runs. Without adjacent data, fill the blank gap below (to
	// the next filled row or the end of the table).
	const onFillHandleDoubleClick = useCallback(() => {
		const source = getCurrentSelectionRect();
		const rows = tableRef.current?.getRowModel().rows ?? [];
		if (!source || propsRef.current.readOnly) {
			return;
		}
		const isFilled = (row: number, col: number) => {
			const columnId = navigableColumnIds[col];
			return columnId
				? !isCellValueEmpty(rows[row]?.getValue(columnId))
				: false;
		};

		let lastRow = source.maxRow;
		for (const neighbor of [source.minCol - 1, source.maxCol + 1]) {
			if (neighbor < 0 || neighbor >= navigableColumnIds.length) {
				continue;
			}
			let row = source.maxRow;
			while (row + 1 < rows.length && isFilled(row + 1, neighbor)) {
				row++;
			}
			if (row > source.maxRow) {
				lastRow = row;
				break;
			}
		}
		if (lastRow === source.maxRow) {
			const isRowBlank = (row: number) => {
				for (let col = source.minCol; col <= source.maxCol; col++) {
					if (isFilled(row, col)) {
						return false;
					}
				}
				return true;
			};
			while (lastRow + 1 < rows.length && isRowBlank(lastRow + 1)) {
				lastRow++;
			}
		}
		if (lastRow === source.maxRow) {
			return;
		}

		const filled = applyFill(
			source,
			{ direction: "down", count: lastRow - source.maxRow },
			"series"
		);
		if (filled) {
			selectRect(filled);
		}
		restoreFocus(dataGridRef.current);
	}, [
		propsRef,
		navigableColumnIds,
		getCurrentSelectionRect,
		applyFill,
		selectRect,
		restoreFocus,
	]);

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

	const onSearch = useCallback(
		(query: string) => {
			if (!query.trim()) {
				store.batch(() => {
					store.setState("searchMatches", []);
					store.setState("matchIndex", -1);
				});
				return;
			}

			const matches: CellPosition[] = [];
			const currentTable = tableRef.current;
			const rows = currentTable?.getRowModel().rows ?? [];

			const lowerQuery = query.toLowerCase();

			for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
				const row = rows[rowIndex];
				if (!row) {
					continue;
				}

				const cellById = new Map(
					row.getVisibleCells().map((c) => [c.column.id, c])
				);

				for (const columnId of columnIds) {
					const cell = cellById.get(columnId);
					if (!cell) {
						continue;
					}

					const value = cell.getValue();
					const stringValue = String(value ?? "").toLowerCase();

					if (stringValue.includes(lowerQuery)) {
						matches.push({ rowIndex, columnId });
					}
				}
			}

			store.batch(() => {
				store.setState("searchMatches", matches);
				store.setState("matchIndex", matches.length > 0 ? 0 : -1);
			});

			if (matches.length > 0 && matches[0]) {
				const firstMatch = matches[0];
				rowVirtualizerRef.current?.scrollToIndex(firstMatch.rowIndex, {
					align: "center",
				});
			}
		},
		[columnIds, store]
	);

	const onSearchQueryChange = useCallback(
		(query: string) => store.setState("searchQuery", query),
		[store]
	);

	const onNavigateToPrevMatch = useCallback(() => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) {
			return;
		}

		const prevIndex =
			currentState.matchIndex - 1 < 0
				? currentState.searchMatches.length - 1
				: currentState.matchIndex - 1;
		const match = currentState.searchMatches[prevIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", prevIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	}, [store, focusCell]);

	const onNavigateToNextMatch = useCallback(() => {
		const currentState = store.getState();
		if (currentState.searchMatches.length === 0) {
			return;
		}

		const nextIndex =
			(currentState.matchIndex + 1) % currentState.searchMatches.length;
		const match = currentState.searchMatches[nextIndex];

		if (match) {
			rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
				align: "center",
			});

			requestAnimationFrame(() => {
				store.setState("matchIndex", nextIndex);
				requestAnimationFrame(() => {
					focusCell(match.rowIndex, match.columnId);
				});
			});
		}
	}, [store, focusCell]);

	const searchMatchSet = useMemo(() => {
		return new Set(
			searchMatches.map((m) => getCellKey(m.rowIndex, m.columnId))
		);
	}, [searchMatches]);

	const getIsSearchMatch = useCallback(
		(rowIndex: number, columnId: string) => {
			return searchMatchSet.has(getCellKey(rowIndex, columnId));
		},
		[searchMatchSet]
	);

	const getIsActiveSearchMatch = useCallback(
		(rowIndex: number, columnId: string) => {
			const currentState = store.getState();
			if (currentState.matchIndex < 0) {
				return false;
			}
			const currentMatch = currentState.searchMatches[currentState.matchIndex];
			return (
				currentMatch?.rowIndex === rowIndex &&
				currentMatch?.columnId === columnId
			);
		},
		[store]
	);

	// Compute search match data for targeted row re-renders
	const searchMatchesByRow = useMemo(() => {
		if (searchMatches.length === 0) {
			return null;
		}
		const rowMap = new Map<number, Set<string>>();
		for (const match of searchMatches) {
			let columnSet = rowMap.get(match.rowIndex);
			if (!columnSet) {
				columnSet = new Set<string>();
				rowMap.set(match.rowIndex, columnSet);
			}
			columnSet.add(match.columnId);
		}
		return rowMap;
	}, [searchMatches]);

	const activeSearchMatch = useMemo<CellPosition | null>(() => {
		if (matchIndex < 0 || searchMatches.length === 0) {
			return null;
		}
		return searchMatches[matchIndex] ?? null;
	}, [searchMatches, matchIndex]);

	const blurCell = useCallback(() => {
		const currentState = store.getState();
		if (
			currentState.editingCell &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}

		store.batch(() => {
			store.setState("focusedCell", null);
			store.setState("editingCell", null);
		});
	}, [store]);

	const scrollToCell = useCallback(
		(rowIndex: number, columnId: string) => {
			requestAnimationFrame(() => {
				const container = dataGridRef.current;
				const cellKey = getCellKey(rowIndex, columnId);
				const targetCell = cellMapRef.current.get(cellKey);

				if (container && targetCell) {
					scrollCellIntoView({
						container,
						targetCell,
						tableRef,
						viewportOffset: VIEWPORT_OFFSET,
						isRtl: dir === "rtl",
					});
				}
			});
		},
		[dir]
	);

	const onCellClick = useCallback(
		(rowIndex: number, columnId: string, event?: MouseEvent) => {
			if (event?.button === 2) {
				return;
			}

			const currentState = store.getState();
			const currentFocused = currentState.focusedCell;

			if (event) {
				if (event.ctrlKey || event.metaKey) {
					event.preventDefault();
					const cellKey = getCellKey(rowIndex, columnId);
					const newSelectedCells = new Set(
						currentState.selectionState.selectedCells
					);

					if (newSelectedCells.has(cellKey)) {
						newSelectedCells.delete(cellKey);
					} else {
						newSelectedCells.add(cellKey);
					}

					store.setState("selectionState", {
						selectedCells: newSelectedCells,
						selectionRange: null,
						isSelecting: false,
					});
					focusCell(rowIndex, columnId);
					scrollToCell(rowIndex, columnId);
					return;
				}

				if (event.shiftKey && currentState.focusedCell) {
					event.preventDefault();
					selectRange(currentState.focusedCell, { rowIndex, columnId });
					scrollToCell(rowIndex, columnId);
					return;
				}
			}

			const hasSelectedCells =
				currentState.selectionState.selectedCells.size > 0;
			const hasSelectedRows = Object.keys(currentState.rowSelection).length > 0;

			if (hasSelectedCells && !currentState.selectionState.isSelecting) {
				const cellKey = getCellKey(rowIndex, columnId);
				const isClickingSelectedCell =
					currentState.selectionState.selectedCells.has(cellKey);

				if (isClickingSelectedCell) {
					focusCell(rowIndex, columnId);
					scrollToCell(rowIndex, columnId);
					return;
				}
				onSelectionClear();
			} else if (hasSelectedRows && columnId !== "select") {
				onSelectionClear();
			}

			if (
				currentFocused?.rowIndex === rowIndex &&
				currentFocused?.columnId === columnId
			) {
				onCellEditingStart(rowIndex, columnId);
			} else {
				focusCell(rowIndex, columnId);
				scrollToCell(rowIndex, columnId);
			}
		},
		[
			store,
			focusCell,
			scrollToCell,
			onCellEditingStart,
			selectRange,
			onSelectionClear,
		]
	);

	const onCellDoubleClick = useCallback(
		(rowIndex: number, columnId: string, event?: MouseEvent) => {
			if (event?.defaultPrevented) {
				return;
			}

			onCellEditingStart(rowIndex, columnId);
		},
		[onCellEditingStart]
	);

	const onCellMouseDown = useCallback(
		(rowIndex: number, columnId: string, event: MouseEvent) => {
			if (event.button === 2) {
				return;
			}

			event.preventDefault();

			if (!(event.ctrlKey || event.metaKey || event.shiftKey)) {
				const cellKey = getCellKey(rowIndex, columnId);
				store.batch(() => {
					store.setState("selectionState", {
						selectedCells: propsRef.current.enableSingleCellSelection
							? new Set([cellKey])
							: new Set(),
						selectionRange: {
							start: { rowIndex, columnId },
							end: { rowIndex, columnId },
						},
						isSelecting: true,
					});
					store.setState("rowSelection", {});
				});
			}
		},
		[store, propsRef]
	);

	const onCellMouseEnter = useCallback(
		(rowIndex: number, columnId: string) => {
			const currentState = store.getState();
			if (currentState.fillDrag) {
				updateFillDrag({ rowIndex, columnId });
				return;
			}
			if (
				currentState.selectionState.isSelecting &&
				currentState.selectionState.selectionRange
			) {
				const start = currentState.selectionState.selectionRange.start;
				const end = { rowIndex, columnId };

				if (
					currentState.focusedCell?.rowIndex !== start.rowIndex ||
					currentState.focusedCell?.columnId !== start.columnId
				) {
					focusCell(start.rowIndex, start.columnId);
				}

				selectRange(start, end, true);
			}
		},
		[store, selectRange, focusCell, updateFillDrag]
	);

	const onCellMouseUp = useCallback(() => {
		const currentState = store.getState();
		store.setState("selectionState", {
			...currentState.selectionState,
			isSelecting: false,
		});
	}, [store]);

	const onCellContextMenu = useCallback(
		(rowIndex: number, columnId: string, event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const currentState = store.getState();
			const cellKey = getCellKey(rowIndex, columnId);
			const isTargetCellSelected =
				currentState.selectionState.selectedCells.has(cellKey);

			if (!isTargetCellSelected) {
				store.batch(() => {
					store.setState("selectionState", {
						selectedCells: new Set([cellKey]),
						selectionRange: {
							start: { rowIndex, columnId },
							end: { rowIndex, columnId },
						},
						isSelecting: false,
					});
					store.setState("focusedCell", { rowIndex, columnId });
				});
			}

			store.setState("contextMenu", {
				open: true,
				x: event.clientX,
				y: event.clientY,
			});
		},
		[store]
	);

	const onContextMenuOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				const currentMenu = store.getState().contextMenu;
				store.setState("contextMenu", {
					open: false,
					x: currentMenu.x,
					y: currentMenu.y,
				});
			}
		},
		[store]
	);

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

	const isFirefox = useSyncExternalStore(
		useCallback(() => () => {}, []),
		useCallback(() => {
			if (
				globalThis.window === undefined ||
				globalThis.navigator === undefined
			) {
				return false;
			}
			return navigator.userAgent.indexOf("Firefox") !== -1;
		}, []),
		useCallback(() => false, [])
	);

	const adjustLayout = useMemo(() => {
		const columnPinning = table.getState().columnPinning;
		return (
			isFirefox &&
			((columnPinning.left?.length ?? 0) > 0 ||
				(columnPinning.right?.length ?? 0) > 0)
		);
	}, [isFirefox, table.getState().columnPinning]);

	const rowVirtualizer = useVirtualizer({
		count: table.getRowModel().rows.length,
		getScrollElement: () => dataGridRef.current,
		estimateSize: () => rowHeightValue,
		overscan,
		measureElement: isFirefox
			? undefined
			: (element) => element?.getBoundingClientRect().height,
		scrollPaddingStart:
			(headerRef.current?.getBoundingClientRect().bottom ?? 0) -
			(dataGridRef.current?.getBoundingClientRect().top ?? 0) +
			VIEWPORT_OFFSET,
		// Add extra row buffer to absorb virtual position drift after render measurements
		scrollPaddingEnd:
			(dataGridRef.current?.getBoundingClientRect().bottom ?? 0) -
			(footerRef.current?.getBoundingClientRect().top ??
				dataGridRef.current?.getBoundingClientRect().bottom ??
				0) +
			rowHeightValue +
			VIEWPORT_OFFSET,
	});

	if (!rowVirtualizerRef.current) {
		rowVirtualizerRef.current = rowVirtualizer;
	}

	const onScrollToRow = useCallback(
		async (opts: Partial<CellPosition>) => {
			const rowIndex = opts?.rowIndex ?? 0;
			const columnId = opts?.columnId;

			focusGuardRef.current = true;

			const navigableIds = propsRef.current.columns
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
				.filter((id): id is string => Boolean(id))
				.filter((c) => !NON_NAVIGABLE_COLUMN_IDS.has(c));

			const targetColumnId = columnId ?? navigableIds[0];

			if (!targetColumnId) {
				releaseFocusGuard(true);
				return;
			}

			async function onScrollAndFocus(retryCount: number) {
				if (!targetColumnId) {
					return;
				}
				const currentRowCount = propsRef.current.data.length;

				// If the requested row doesn't exist yet, wait for data to update
				if (rowIndex >= currentRowCount && retryCount > 0) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					await onScrollAndFocus(retryCount - 1);
					return;
				}

				const safeRowIndex = Math.min(
					rowIndex,
					Math.max(0, currentRowCount - 1)
				);

				const isBottomHalf = safeRowIndex > currentRowCount / 2;
				rowVirtualizer.scrollToIndex(safeRowIndex, {
					align: isBottomHalf ? "end" : "start",
				});

				await new Promise((resolve) => requestAnimationFrame(resolve));

				// Adjust scroll position to account for sticky header/footer
				const container = dataGridRef.current;
				const targetRow = rowMapRef.current.get(safeRowIndex);

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
						if (rowRect.top < viewportTop) {
							// Scroll up as row is partially hidden by header
							container.scrollTop -= viewportTop - rowRect.top;
						} else if (rowRect.bottom > viewportBottom) {
							// Scroll down as row is partially hidden by footer
							container.scrollTop += rowRect.bottom - viewportBottom;
						}
					}
				}

				store.batch(() => {
					store.setState("focusedCell", {
						rowIndex: safeRowIndex,
						columnId: targetColumnId,
					});
					store.setState("editingCell", null);
				});

				const cellKey = getCellKey(safeRowIndex, targetColumnId);
				const cellElement = cellMapRef.current.get(cellKey);

				if (cellElement) {
					cellElement.focus();
					releaseFocusGuard();
				} else if (retryCount > 0) {
					await new Promise((resolve) => requestAnimationFrame(resolve));
					await onScrollAndFocus(retryCount - 1);
				} else {
					dataGridRef.current?.focus();
					releaseFocusGuard();
				}
			}

			await onScrollAndFocus(SCROLL_SYNC_RETRY_COUNT);
		},
		[rowVirtualizer, propsRef, store, releaseFocusGuard]
	);

	// After an "Add row", record whichever rows appeared so Ctrl+Z removes them.
	const getCoreRowIds = useCallback(
		() =>
			new Set(
				(tableRef.current?.getCoreRowModel().rows ?? []).map((r) => r.id)
			),
		[]
	);

	const recordAddedRows = useCallback(
		(before: Set<string>) => {
			const added = (tableRef.current?.getCoreRowModel().rows ?? []).filter(
				(row) => !before.has(row.id)
			);
			if (added.length > 0) {
				pushHistory({
					kind: "rows-inserted",
					rows: added.map((row) => ({
						rowId: row.id,
						dataIndex: row.index,
						original: null,
					})),
				});
			}
		},
		[pushHistory]
	);

	const onRowAdd = useCallback(
		async (event?: MouseEvent<HTMLDivElement>) => {
			if (propsRef.current.readOnly || !propsRef.current.onRowAdd) {
				return;
			}

			const initialRowCount = propsRef.current.data.length;
			const rowIdsBefore = getCoreRowIds();

			let result: Partial<CellPosition> | null;
			try {
				result = await propsRef.current.onRowAdd(event);
			} catch {
				// Callback threw an error, don't proceed with scroll/focus
				return;
			}

			if (result === null || event?.defaultPrevented) {
				return;
			}

			onSelectionClear();

			// onScrollToRow will handle retries if the row isn't rendered yet
			const targetRowIndex = result.rowIndex ?? initialRowCount;
			const targetColumnId = result.columnId;

			await onScrollToRow({
				rowIndex: targetRowIndex,
				columnId: targetColumnId,
			});
			recordAddedRows(rowIdsBefore);
		},
		[propsRef, onScrollToRow, onSelectionClear, getCoreRowIds, recordAddedRows]
	);

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

			let direction: NavigationDirection | null = null;

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
							const cellKey = getCellKey(
								selectionEdge.rowIndex,
								targetColumnId
							);
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
							const cellKey = getCellKey(
								selectionEdge.rowIndex,
								targetColumnId
							);
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

	useEffect(() => {
		function onGlobalKeyDown(event: KeyboardEvent) {
			const dataGridElement = dataGridRef.current;
			if (!dataGridElement) {
				return;
			}

			const target = event.target;
			if (!(target instanceof HTMLElement)) {
				return;
			}

			const { key, ctrlKey, metaKey, shiftKey } = event;
			const isCommandPressed = ctrlKey || metaKey;

			if (
				propsRef.current.enableSearch &&
				isCommandPressed &&
				!shiftKey &&
				key === SEARCH_SHORTCUT_KEY
			) {
				const isInInput =
					target.tagName === "INPUT" || target.tagName === "TEXTAREA";
				const isInDataGrid = dataGridElement.contains(target);
				const isInSearchInput = target.closest('[role="search"]') !== null;

				if (isInDataGrid || isInSearchInput || !isInInput) {
					event.preventDefault();
					event.stopPropagation();

					const nextSearchOpen = !store.getState().searchOpen;
					onSearchOpenChange(nextSearchOpen);

					if (nextSearchOpen && !isInDataGrid && !isInSearchInput) {
						requestAnimationFrame(() => {
							dataGridElement.focus();
						});
					}
					return;
				}
			}

			const isInDataGrid = dataGridElement.contains(target);
			if (!isInDataGrid) {
				return;
			}

			if (key === "Escape") {
				const currentState = store.getState();
				const hasSelections =
					currentState.selectionState.selectedCells.size > 0 ||
					Object.keys(currentState.rowSelection).length > 0;

				if (hasSelections) {
					event.preventDefault();
					event.stopPropagation();
					onSelectionClear();
				}
			}
		}

		window.addEventListener("keydown", onGlobalKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onGlobalKeyDown, true);
		};
	}, [propsRef, onSearchOpenChange, store, onSelectionClear]);

	useEffect(() => {
		const currentState = store.getState();
		const autoFocus = propsRef.current.autoFocus;

		if (
			autoFocus &&
			data.length > 0 &&
			columns.length > 0 &&
			!currentState.focusedCell &&
			navigableColumnIds.length > 0
		) {
			const rafId = requestAnimationFrame(() => {
				if (autoFocus !== true) {
					const { rowIndex, columnId } = autoFocus;
					if (columnId) {
						focusCell(rowIndex ?? 0, columnId);
					}
					return;
				}

				const firstColumnId = navigableColumnIds[0];
				if (firstColumnId) {
					focusCell(0, firstColumnId);
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [store, propsRef, data, columns, navigableColumnIds, focusCell]);

	// Restore focus to container when virtualized cells are unmounted
	useEffect(() => {
		const container = dataGridRef.current;
		if (!container) {
			return;
		}

		function onFocusOut(event: FocusEvent) {
			if (focusGuardRef.current) {
				return;
			}

			const currentContainer = dataGridRef.current;
			if (!currentContainer) {
				return;
			}

			const currentState = store.getState();

			if (!currentState.focusedCell || currentState.editingCell) {
				return;
			}

			const relatedTarget = event.relatedTarget;

			const isFocusMovingOutsideGrid = !(
				relatedTarget && isGridEventInside(currentContainer, relatedTarget)
			);

			const isFocusMovingToPopover = getIsInPopover(relatedTarget);

			if (isFocusMovingOutsideGrid && !isFocusMovingToPopover) {
				const { rowIndex, columnId } = currentState.focusedCell;
				const cellKey = getCellKey(rowIndex, columnId);
				const cellElement = cellMapRef.current.get(cellKey);

				requestAnimationFrame(() => {
					if (focusGuardRef.current) {
						return;
					}

					if (cellElement && document.body.contains(cellElement)) {
						cellElement.focus();
					} else {
						currentContainer.focus();
					}
				});
			}
		}

		container.addEventListener("focusout", onFocusOut);

		return () => {
			container.removeEventListener("focusout", onFocusOut);
		};
	}, [store]);

	useEffect(() => {
		function onOutsideClick(event: globalThis.MouseEvent) {
			if (event.button === 2) {
				return;
			}

			if (
				dataGridRef.current &&
				!isGridEventInside(dataGridRef.current, event.target)
			) {
				const elements = document.elementsFromPoint(
					event.clientX,
					event.clientY
				);

				// Compensate for event.target bubbling up
				const isInsidePopover = elements.some((element) =>
					getIsInPopover(element)
				);

				if (!isInsidePopover) {
					blurCell();
					const currentState = store.getState();
					if (
						currentState.selectionState.selectedCells.size > 0 ||
						Object.keys(currentState.rowSelection).length > 0
					) {
						onSelectionClear();
					}
				}
			}
		}

		document.addEventListener("mousedown", onOutsideClick);
		return () => {
			document.removeEventListener("mousedown", onOutsideClick);
		};
	}, [store, blurCell, onSelectionClear]);

	useEffect(() => {
		function onSelectStart(event: Event) {
			event.preventDefault();
		}

		function onContextMenu(event: Event) {
			event.preventDefault();
		}

		function onCleanup() {
			document.removeEventListener("selectstart", onSelectStart);
			document.removeEventListener("contextmenu", onContextMenu);
			document.body.style.userSelect = "";
		}

		const onUnsubscribe = store.subscribe(() => {
			const currentState = store.getState();
			if (currentState.selectionState.isSelecting) {
				document.addEventListener("selectstart", onSelectStart);
				document.addEventListener("contextmenu", onContextMenu);
				document.body.style.userSelect = "none";
			} else {
				onCleanup();
			}
		});

		return () => {
			onCleanup();
			onUnsubscribe();
		};
	}, [store]);

	useEffect(() => {
		let rafId: number | null = null;
		let mouseX = 0;
		let mouseY = 0;
		let mouseReady = false;
		let active = false;
		let lastSelectionTime = 0;
		let resizeObserver: ResizeObserver | null = null;

		let cachedRect: DOMRect | null = null;
		let cachedHdrH = 0;
		let cachedFtrH = 0;
		let cachedLpw = 0;
		let cachedRpw = 0;

		function getAutoScrollSpeed(dist: number): number {
			const t = Math.min(dist / AUTO_SCROLL_SPEED_RAMP_ZONE, 1);
			return Math.round(
				AUTO_SCROLL_MIN_SPEED +
					(AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED) * t
			);
		}

		function cacheLayout(container: HTMLDivElement) {
			cachedRect = container.getBoundingClientRect();
			cachedHdrH = headerRef.current?.getBoundingClientRect().height ?? 0;
			cachedFtrH = footerRef.current?.getBoundingClientRect().height ?? 0;
			const tbl = tableRef.current;
			if (tbl) {
				cachedLpw = tbl
					.getLeftVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
				cachedRpw = tbl
					.getRightVisibleLeafColumns()
					.reduce((s, c) => s + c.getSize(), 0);
			}
		}

		function tick() {
			if (!active) {
				return;
			}
			const container = dataGridRef.current;
			const tbl = tableRef.current;

			if (!(container && tbl)) {
				onAutoScrollStop();
				return;
			}

			if (!(mouseReady && cachedRect)) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const rect = cachedRect;
			const { dir } = dragDepsRef.current;
			const hasNegativeScroll = container.scrollLeft < 0;
			const isActuallyRtl = dir === "rtl" || hasNegativeScroll;

			const dataTop = rect.top + cachedHdrH;
			const dataBottom = rect.bottom - cachedFtrH;

			const scrollAreaLeft = isActuallyRtl
				? rect.left + cachedRpw
				: rect.left + cachedLpw;
			const scrollAreaRight = isActuallyRtl
				? rect.right - cachedLpw
				: rect.right - cachedRpw;

			let dy = 0;
			let dx = 0;

			if (mouseY < dataTop) {
				dy = -getAutoScrollSpeed(dataTop - mouseY);
			} else if (mouseY > dataBottom) {
				dy = getAutoScrollSpeed(mouseY - dataBottom);
			}

			if (mouseX < scrollAreaLeft) {
				dx = -getAutoScrollSpeed(scrollAreaLeft - mouseX);
			} else if (mouseX > scrollAreaRight) {
				dx = getAutoScrollSpeed(mouseX - scrollAreaRight);
			}

			if (dx === 0 && dy === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			container.scrollTop += dy;
			container.scrollLeft += dx;

			const now = performance.now();
			if (now - lastSelectionTime < AUTO_SCROLL_SELECTION_THROTTLE_MS) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const { rowHeightValue: rh, columnIds } = dragDepsRef.current;
			if (columnIds.length === 0) {
				rafId = requestAnimationFrame(tick);
				return;
			}

			const totalRows = tbl.getRowModel().rows.length;
			const clampedY = Math.max(dataTop, Math.min(mouseY, dataBottom));
			const absY = container.scrollTop + (clampedY - dataTop);
			const rowIndex = Math.max(
				0,
				Math.min(Math.floor(absY / rh), totalRows - 1)
			);

			const st = store.getState();
			const range = st.selectionState.selectionRange;
			const fillEnd = st.fillDrag?.end;
			const currentEnd = fillEnd ?? range?.end;

			let columnId: string | undefined;

			if (dx !== 0) {
				const clampedX = Math.max(rect.left, Math.min(mouseX, rect.right));
				const relX = clampedX - rect.left;

				const leftZoneWidth = isActuallyRtl ? cachedRpw : cachedLpw;
				const rightZoneWidth = isActuallyRtl ? cachedLpw : cachedRpw;

				if (relX < leftZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getRightVisibleLeafColumns()
						: tbl.getLeftVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds[0] ?? "";
					let cx = 0;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else if (relX > rect.width - rightZoneWidth) {
					const columns = isActuallyRtl
						? tbl.getLeftVisibleLeafColumns()
						: tbl.getRightVisibleLeafColumns();
					columnId = columns[0]?.id ?? columnIds.at(-1) ?? "";
					let cx = rect.width - rightZoneWidth;
					for (const col of columns) {
						if (relX < cx + col.getSize()) {
							columnId = col.id;
							break;
						}
						cx += col.getSize();
					}
				} else {
					const center = tbl.getCenterVisibleLeafColumns();
					const centerZoneWidth = rect.width - leftZoneWidth - rightZoneWidth;
					const distFromVisualLeft = relX - leftZoneWidth;

					let absX: number;
					if (isActuallyRtl) {
						const scrollFromRight = hasNegativeScroll
							? -container.scrollLeft
							: container.scrollWidth -
								container.clientWidth -
								container.scrollLeft;
						absX = scrollFromRight + (centerZoneWidth - distFromVisualLeft);
					} else {
						absX = container.scrollLeft + distFromVisualLeft;
					}

					columnId = center.at(-1)?.id ?? columnIds.at(-1) ?? "";
					let cw = 0;
					for (const col of center) {
						cw += col.getSize();
						if (absX < cw) {
							columnId = col.id;
							break;
						}
					}
				}
			}

			if (!columnId) {
				columnId = currentEnd?.columnId ?? columnIds[0] ?? "";
			}

			if (
				currentEnd &&
				(rowIndex !== currentEnd.rowIndex || columnId !== currentEnd.columnId)
			) {
				if (fillEnd) {
					fillDragDepsRef.current.updateFillDrag({ rowIndex, columnId });
				} else if (range) {
					dragDepsRef.current.selectRange(
						range.start,
						{ rowIndex, columnId },
						true
					);
				}
				lastSelectionTime = now;
			}

			rafId = requestAnimationFrame(tick);
		}

		function onMove(event: globalThis.MouseEvent) {
			mouseX = event.clientX;
			mouseY = event.clientY;
			mouseReady = true;
		}

		function onUp() {
			onAutoScrollStop();
			const st = store.getState();
			if (st.selectionState.isSelecting) {
				store.setState("selectionState", {
					...st.selectionState,
					isSelecting: false,
				});
			}
		}

		function onAutoScrollStart() {
			if (active) {
				return;
			}

			const container = dataGridRef.current;
			if (!container) {
				return;
			}

			active = true;
			mouseReady = false;
			cachedRect = null;
			lastSelectionTime = 0;
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			resizeObserver = new ResizeObserver(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) {
					cacheLayout(currentContainer);
				}
			});
			resizeObserver.observe(container);
			rafId = requestAnimationFrame(() => {
				const currentContainer = dataGridRef.current;
				if (currentContainer) {
					cacheLayout(currentContainer);
				}
				rafId = requestAnimationFrame(tick);
			});
		}

		function onAutoScrollStop() {
			if (!active) {
				return;
			}
			active = false;
			cachedRect = null;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			resizeObserver?.disconnect();
			resizeObserver = null;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		}

		const isDragging = () => {
			const st = store.getState();
			return st.selectionState.isSelecting || st.fillDrag !== null;
		};

		if (isDragging()) {
			onAutoScrollStart();
		}

		const onUnsubscribe = store.subscribe(() => {
			const dragging = isDragging();
			if (dragging && !active) {
				onAutoScrollStart();
			} else if (!dragging && active) {
				onAutoScrollStop();
			}
		});

		return () => {
			onAutoScrollStop();
			onUnsubscribe();
		};
	}, [store, dragDepsRef, fillDragDepsRef]);

	useIsomorphicLayoutEffect(() => {
		const rafId = requestAnimationFrame(() => {
			rowVirtualizer.measure();
		});
		return () => cancelAnimationFrame(rafId);
	}, [
		rowHeight,
		table.getState().columnFilters,
		table.getState().columnOrder,
		table.getState().columnPinning,
		table.getState().columnSizing,
		table.getState().columnVisibility,
		table.getState().expanded,
		table.getState().globalFilter,
		table.getState().grouping,
		table.getState().rowSelection,
		table.getState().sorting,
	]);

	const readOnly = propsRef.current.readOnly ?? false;

	// The fill handle sits on the bottom-end cell of a rectangular selection.
	const fillHandleCell = useMemo<CellPosition | null>(() => {
		if (readOnly || editingCell) {
			return null;
		}
		const rect = getSelectionRect({
			columnIds,
			focusedCell,
			navigableColumnIds,
			selectionState,
		});
		const columnId = rect && navigableColumnIds[rect.maxCol];
		return rect && columnId ? { rowIndex: rect.maxRow, columnId } : null;
	}, [
		readOnly,
		editingCell,
		focusedCell,
		selectionState,
		columnIds,
		navigableColumnIds,
	]);

	const enableSelectionSummary =
		propsRef.current.enableSelectionSummary ?? false;

	// The row model's identity changes when sorting or filtering reorders rows,
	// which re-maps the visual row indices the selection is stored as.
	const visibleRows = table.getRowModel().rows;

	const selectionSummary = useMemo<SelectionSummary | null>(() => {
		if (!enableSelectionSummary || selectionState.selectedCells.size < 2) {
			return null;
		}
		const rows = visibleRows;
		const values: unknown[] = [];
		for (const cellKey of selectionState.selectedCells) {
			const { rowIndex, columnId } = parseCellKey(cellKey);
			if (!NON_NAVIGABLE_COLUMN_IDS.has(columnId)) {
				values.push(rows[rowIndex]?.getValue(columnId));
			}
		}
		return summarizeValues(values);
	}, [enableSelectionSummary, selectionState.selectedCells, visibleRows]);

	const virtualTotalSize = rowVirtualizer.getTotalSize();
	const virtualItems = rowVirtualizer.getVirtualItems();
	const measureElement = rowVirtualizer.measureElement;

	return useMemo(
		() => ({
			dataGridRef,
			headerRef,
			rowMapRef,
			footerRef,
			dir,
			table,
			tableMeta,
			virtualTotalSize,
			virtualItems,
			measureElement,
			columns,
			columnSizeVars,
			searchState,
			searchMatchesByRow,
			activeSearchMatch,
			cellSelectionMap,
			focusedCell,
			editingCell,
			rowHeight,
			contextMenu,
			pasteDialog,
			onRowAdd: propsRef.current.onRowAdd ? onRowAdd : undefined,
			adjustLayout,
			fillHandleCell,
			enableSelectionSummary,
			selectionSummary,
		}),
		[
			propsRef,
			dir,
			table,
			tableMeta,
			virtualTotalSize,
			virtualItems,
			measureElement,
			columns,
			columnSizeVars,
			searchState,
			searchMatchesByRow,
			activeSearchMatch,
			cellSelectionMap,
			focusedCell,
			editingCell,
			rowHeight,
			contextMenu,
			pasteDialog,
			onRowAdd,
			adjustLayout,
			fillHandleCell,
			enableSelectionSummary,
			selectionSummary,
		]
	);
}

export { type UseDataGridProps, useDataGrid };
