import { SHEET_COLUMNS } from "./sheet-model.ts";

// ---------------------------------------------------------------------------
// Cell cursor
// ---------------------------------------------------------------------------

/** A cell position: `row` -1 is the header row, `col` indexes SHEET_COLUMNS. */
export interface SheetCell {
	col: number;
	row: number;
}

export interface SheetMoveKey {
	ctrlKey?: boolean;
	key: string;
	metaKey?: boolean;
}

/** Rows a Page Up / Page Down jumps. */
export const SHEET_PAGE_ROWS = 10;

/**
 * Where a key moves the cursor, spreadsheet style: arrows step, Home/End go to
 * the row's ends, Ctrl/Cmd+Home/End to the sheet's corners, Page keys jump.
 * Returns null for keys that do not move. The header row is reachable with
 * ArrowUp from the first row (it hosts sort and resize).
 */
export function moveSheetCell(
	cell: SheetCell,
	input: SheetMoveKey,
	rowCount: number,
	colCount: number = SHEET_COLUMNS.length
): SheetCell | null {
	const lastRow = rowCount - 1;
	const lastCol = colCount - 1;
	const corner = input.ctrlKey === true || input.metaKey === true;
	switch (input.key) {
		case "ArrowDown":
			return { col: cell.col, row: Math.min(lastRow, cell.row + 1) };
		case "ArrowUp":
			return { col: cell.col, row: Math.max(-1, cell.row - 1) };
		case "ArrowLeft":
			return { col: Math.max(0, cell.col - 1), row: cell.row };
		case "ArrowRight":
			return { col: Math.min(lastCol, cell.col + 1), row: cell.row };
		case "Home":
			return corner
				? { col: 0, row: Math.min(0, lastRow) }
				: { col: 0, row: cell.row };
		case "End":
			return corner
				? { col: lastCol, row: lastRow }
				: { col: lastCol, row: cell.row };
		case "PageDown":
			return {
				col: cell.col,
				row: Math.min(lastRow, Math.max(0, cell.row + SHEET_PAGE_ROWS)),
			};
		case "PageUp":
			return {
				col: cell.col,
				row: Math.max(Math.min(0, lastRow), cell.row - SHEET_PAGE_ROWS),
			};
		default:
			return null;
	}
}
