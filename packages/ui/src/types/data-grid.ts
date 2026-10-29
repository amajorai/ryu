import type { Cell, RowData, TableMeta } from "@tanstack/react-table";

export type Direction = "ltr" | "rtl";

export type RowHeightValue = "short" | "medium" | "tall" | "extra-tall";

export interface CellSelectOption {
	/** Notion-style tag color (a key of the shared palette, e.g. "blue"). */
	color?: string;
	count?: number;
	icon?: React.ComponentType<React.ComponentProps<"svg">>;
	label: string;
	value: string;
}

/** Conditional-formatting comparisons (Excel's "Highlight Cells Rules"). */
export type CellFormatOperator =
	| "isEmpty"
	| "isNotEmpty"
	| "equals"
	| "notEquals"
	| "contains"
	| "notContains"
	| "greaterThan"
	| "greaterThanOrEqual"
	| "lessThan"
	| "lessThanOrEqual";

/** Tint a cell with `color` (a select-option palette key) when it matches. */
export interface CellFormatRule {
	color: string;
	id: string;
	operator: CellFormatOperator;
	value?: string;
}

interface CellFormatOpts {
	/** Conditional formatting; the first matching rule colors the cell. */
	formatRules?: CellFormatRule[];
}

export type CellOpts = CellFormatOpts &
	(
		| {
				variant: "short-text";
		  }
		| {
				variant: "long-text";
		  }
		| {
				variant: "number";
				min?: number;
				max?: number;
				step?: number;
		  }
		| {
				variant: "select";
				options: CellSelectOption[];
		  }
		| {
				variant: "multi-select";
				options: CellSelectOption[];
		  }
		| {
				variant: "checkbox";
		  }
		| {
				variant: "date";
		  }
		| {
				variant: "url";
		  }
		| {
				variant: "file";
				maxFileSize?: number;
				maxFiles?: number;
				accept?: string;
				multiple?: boolean;
		  }
		| {
				/** Read-only value computed from other columns (see data-grid-formula.ts). */
				variant: "formula";
				expression: string;
		  }
	);

export interface CellUpdate {
	columnId: string;
	rowIndex: number;
	value: unknown;
}

declare module "@tanstack/react-table" {
	interface ColumnMeta<TData extends RowData, TValue> {
		cell?: CellOpts;
		label?: string;
	}

	interface TableMeta<TData extends RowData> {
		cellMapRef?: React.RefObject<Map<string, HTMLDivElement>>;
		contextMenu?: ContextMenuState;
		dataGridRef?: React.RefObject<HTMLElement | null>;
		editingCell?: CellPosition | null;
		focusedCell?: CellPosition | null;
		getIsActiveSearchMatch?: (rowIndex: number, columnId: string) => boolean;
		getIsCellSelected?: (rowIndex: number, columnId: string) => boolean;
		getIsSearchMatch?: (rowIndex: number, columnId: string) => boolean;
		getVisualRowIndex?: (rowId: string) => number | undefined;
		onCellClick?: (
			rowIndex: number,
			columnId: string,
			event?: React.MouseEvent
		) => void;
		onCellContextMenu?: (
			rowIndex: number,
			columnId: string,
			event: React.MouseEvent
		) => void;
		onCellDoubleClick?: (rowIndex: number, columnId: string) => void;
		onCellEditingStart?: (rowIndex: number, columnId: string) => void;
		onCellEditingStop?: (opts?: {
			direction?: NavigationDirection;
			moveToNextRow?: boolean;
		}) => void;
		onCellMouseDown?: (
			rowIndex: number,
			columnId: string,
			event: React.MouseEvent
		) => void;
		onCellMouseEnter?: (rowIndex: number, columnId: string) => void;
		onCellMouseUp?: () => void;
		onCellsCopy?: () => void;
		onCellsCut?: () => void;
		onCellsPaste?: (expand?: boolean, overrideText?: string) => void;
		/** Paste the clipboard with its rows and columns swapped. */
		onCellsPasteTransposed?: () => void;
		/** Size a column to fit its header and cell contents (Excel's double-click on the border). */
		onColumnAutoFit?: (columnId: string) => void;
		onColumnClick?: (columnId: string) => void;
		/** Open the column (property) editor — rename / change type / edit options. */
		onColumnEdit?: (columnId: string) => void;
		onContextMenuOpenChange?: (open: boolean) => void;
		onDataUpdate?: (params: CellUpdate | CellUpdate[]) => void;
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
		/** Double-click on the fill handle: AutoFill down to the end of the adjacent data. */
		onFillHandleDoubleClick?: () => void;
		/** Start dragging the fill handle at the selection's bottom-end corner. */
		onFillHandleMouseDown?: (event: React.MouseEvent) => void;
		/** Ctrl+D / Ctrl+R: copy the first row/column of the selection across it. */
		onFillSelection?: (direction: "down" | "right") => void;
		onPasteDialogOpenChange?: (open: boolean) => void;
		onRedo?: () => void;
		onRowHeightChange?: (value: RowHeightValue) => void;
		onRowSelect?: (rowId: string, checked: boolean, shiftKey: boolean) => void;
		onRowsDelete?: (rowIndices: number[]) => void | Promise<void>;
		/** Insert empty rows above/below the selection, or duplicate it below. */
		onRowsInsert?: (position: "above" | "below" | "duplicate") => void;
		onSelectionClear?: () => void;
		onUndo?: () => void;
		pasteDialog?: PasteDialogState;
		readOnly?: boolean;
		rowHeight?: RowHeightValue;
		scrollToCell?: (
			rowIndex: number,
			columnId: string,
			align?: "auto" | "start" | "center" | "end"
		) => void;
		searchOpen?: boolean;
		selectionState?: SelectionState;
	}
}

export interface CellPosition {
	columnId: string;
	rowIndex: number;
}

export interface CellRange {
	end: CellPosition;
	start: CellPosition;
}

export interface SelectionState {
	isSelecting: boolean;
	selectedCells: Set<string>;
	selectionRange: CellRange | null;
}

export interface ContextMenuState {
	open: boolean;
	x: number;
	y: number;
}

export interface PasteDialogState {
	clipboardText: string;
	open: boolean;
	rowsNeeded: number;
	/** Raw clipboard text `clipboardText` was derived from (e.g. before transposing). */
	sourceClipboardText?: string;
}

export type NavigationDirection =
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "ctrl+up"
	| "ctrl+down"
	| "ctrl+left"
	| "ctrl+right"
	| "ctrl+home"
	| "ctrl+end"
	| "pageup"
	| "pagedown"
	| "pageleft"
	| "pageright";

export interface SearchState {
	matchIndex: number;
	onNavigateToNextMatch: () => void;
	onNavigateToPrevMatch: () => void;
	onSearch: (query: string) => void;
	onSearchOpenChange: (open: boolean) => void;
	onSearchQueryChange: (query: string) => void;
	searchMatches: CellPosition[];
	searchOpen: boolean;
	searchQuery: string;
}

export interface DataGridCellProps<TData> {
	cell: Cell<TData, unknown>;
	columnId: string;
	isActiveSearchMatch: boolean;
	isEditing: boolean;
	isFocused: boolean;
	isSearchMatch: boolean;
	isSelected: boolean;
	readOnly: boolean;
	rowHeight: RowHeightValue;
	rowIndex: number;
	tableMeta: TableMeta<TData>;
}

export interface FileCellData {
	id: string;
	name: string;
	size: number;
	type: string;
	url?: string;
}

export type TextFilterOperator =
	| "contains"
	| "notContains"
	| "equals"
	| "notEquals"
	| "startsWith"
	| "endsWith"
	| "isEmpty"
	| "isNotEmpty";

export type NumberFilterOperator =
	| "equals"
	| "notEquals"
	| "lessThan"
	| "lessThanOrEqual"
	| "greaterThan"
	| "greaterThanOrEqual"
	| "isBetween"
	| "isEmpty"
	| "isNotEmpty";

export type DateFilterOperator =
	| "equals"
	| "notEquals"
	| "before"
	| "after"
	| "onOrBefore"
	| "onOrAfter"
	| "isBetween"
	| "isEmpty"
	| "isNotEmpty";

export type SelectFilterOperator =
	| "is"
	| "isNot"
	| "isAnyOf"
	| "isNoneOf"
	| "isEmpty"
	| "isNotEmpty";

export type BooleanFilterOperator = "isTrue" | "isFalse";

export type FilterOperator =
	| TextFilterOperator
	| NumberFilterOperator
	| DateFilterOperator
	| SelectFilterOperator
	| BooleanFilterOperator;

export interface FilterValue {
	endValue?: string | number;
	operator: FilterOperator;
	value?: string | number | string[];
}
