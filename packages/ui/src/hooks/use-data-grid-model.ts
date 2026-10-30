import type { GridRect } from "@ryu/ui/lib/data-grid-fill.ts";
import type {
	CellOpts,
	CellPosition,
	CellUpdate,
	ContextMenuState,
	Direction,
	FileCellData,
	PasteDialogState,
	RowHeightValue,
	SelectionState,
} from "@ryu/ui/types/data-grid.ts";
import type {
	ColumnFiltersState,
	RowSelectionState,
	SortingState,
	TableOptions,
	Updater,
} from "@tanstack/react-table";
import { type MouseEvent, useCallback, useSyncExternalStore } from "react";
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

export {
	AUTO_FIT_CELL_PADDING,
	AUTO_FIT_CHIP_PADDING,
	AUTO_FIT_HEADER_CHROME,
	AUTO_FIT_ROW_LIMIT,
	AUTO_SCROLL_EDGE_ZONE,
	AUTO_SCROLL_MAX_SPEED,
	AUTO_SCROLL_MIN_SPEED,
	AUTO_SCROLL_SELECTION_THROTTLE_MS,
	AUTO_SCROLL_SPEED_RAMP_ZONE,
	type CellChange,
	type ClipboardCellValue,
	type ColumnSizeStyle,
	type DataGridState,
	type DataGridStore,
	DEFAULT_ROW_HEIGHT,
	DOMAIN_REGEX,
	type FillDragState,
	getSelectionRect,
	gridColumnIdSchema,
	gridEventNodeSchema,
	HISTORY_LIMIT,
	type HistoryEntry,
	HORIZONTAL_PAGE_SIZE,
	ISO_DATE_REGEX,
	isFillValueCompatible,
	isGridEventInside,
	isGridStateUpdater,
	MAX_COLUMN_SIZE,
	MIN_COLUMN_SIZE,
	NON_NAVIGABLE_COLUMN_IDS,
	nativeUpdaterSchema,
	OVERSCAN,
	type RowSnapshot,
	SCROLL_SYNC_RETRY_COUNT,
	SEARCH_SHORTCUT_KEY,
	TRUTHY_BOOLEANS,
	type UseDataGridProps,
	useStore,
	VALID_BOOLEANS,
	VIEWPORT_OFFSET,
};
