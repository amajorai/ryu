import { cn } from "@ryu/ui/lib/utils";
import type { FocusEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import {
	ANIMATED_ROW_LIMIT,
	CELL,
	HEADER_EDGE,
	KEY_RESIZE_STEP,
	ROW_HEIGHT,
	SKELETON_ROWS,
} from "./sheet-grid-constants.ts";
import { HeaderCell } from "./sheet-grid-header.tsx";
import { SheetGridRow, SkeletonRow } from "./sheet-grid-row.tsx";
import {
	clampColumnWidth,
	moveSheetCell,
	SHEET_COLUMNS,
	SHEET_GUTTER_WIDTH,
	type SheetCell,
	type SheetColumnId,
	type SheetRow,
	type SheetSort,
	type SheetWidths,
} from "./sheet-model.ts";

export { SHEET_COLUMN_ICON } from "./sheet-grid-constants.ts";
export { SheetSummaryBar } from "./sheet-grid-summary.tsx";

/** The cell a DOM node sits in, read from its data attributes. */
function cellFromTarget(target: EventTarget | null): SheetCell | null {
	if (!(target instanceof Element)) {
		return null;
	}
	const element = target.closest<HTMLElement>("[data-sheet-col]");
	if (!element) {
		return null;
	}
	const row = Number(element.dataset.sheetRow);
	const col = Number(element.dataset.sheetCol);
	return Number.isFinite(row) && Number.isFinite(col) ? { col, row } : null;
}

/** Scroll just enough to show a cell that is hidden behind the frozen header or column. */
function revealCell(
	container: HTMLElement,
	element: HTMLElement,
	frozenWidth: number,
	frozen: boolean
) {
	const box = container.getBoundingClientRect();
	const cell = element.getBoundingClientRect();
	const top = box.top + ROW_HEIGHT;
	const summary = container.querySelector<HTMLElement>("[data-sheet-summary]");
	const bottom =
		box.top + container.clientHeight - (summary?.offsetHeight ?? 0);
	if (cell.top < top && !element.closest("thead")) {
		container.scrollTop -= top - cell.top;
	} else if (cell.bottom > bottom) {
		container.scrollTop += cell.bottom - bottom;
	}
	if (frozen) {
		return;
	}
	const left = box.left + frozenWidth;
	const right = box.left + container.clientWidth;
	if (cell.left < left) {
		container.scrollLeft -= left - cell.left;
	} else if (cell.right > right) {
		container.scrollLeft += cell.right - right;
	}
}

export interface SheetGridCursor {
	col: number;
	/** -1 for the header row, else an index into `rows`. */
	row: number;
}

export function SheetGrid({
	animateRows,
	cursor,
	cursorActive,
	describedBy,
	gridRef,
	loading,
	now,
	onCursor,
	onOpen,
	onResize,
	onSort,
	openThreadId,
	query,
	rows,
	scrollRef,
	sort,
	widths,
}: {
	animateRows: boolean;
	cursor: SheetGridCursor;
	cursorActive: boolean;
	describedBy: string;
	gridRef: RefObject<HTMLTableElement | null>;
	loading: boolean;
	now: number;
	onCursor: (cell: SheetGridCursor) => void;
	onOpen: (threadId: string) => void;
	onResize: (id: SheetColumnId, width: number) => void;
	onSort: (id: SheetColumnId) => void;
	openThreadId: string | null;
	query: string;
	rows: readonly SheetRow[];
	scrollRef: RefObject<HTMLDivElement | null>;
	sort: SheetSort | null;
	widths: SheetWidths;
}) {
	const totalWidth =
		SHEET_GUTTER_WIDTH +
		SHEET_COLUMNS.reduce((sum, column) => sum + widths[column.id], 0);
	const frozenWidth = SHEET_GUTTER_WIDTH + widths.title;
	const animate = animateRows && rows.length <= ANIMATED_ROW_LIMIT;

	const cellElement = (cell: SheetCell): HTMLElement | null => {
		const table = gridRef.current;
		if (!table) {
			return null;
		}
		return table.querySelector<HTMLElement>(
			`[data-sheet-row="${cell.row}"][data-sheet-col="${cell.col}"]`
		);
	};

	const focusCell = (cell: SheetCell) => {
		const element = cellElement(cell);
		const container = scrollRef.current;
		if (!element) {
			return;
		}
		element.focus({ preventScroll: true });
		if (container) {
			revealCell(container, element, frozenWidth, cell.col === 0);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
		const cell = cellFromTarget(event.target);
		if (!cell) {
			return;
		}
		const column = SHEET_COLUMNS[cell.col];
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (cell.row < 0) {
				if (column) {
					onSort(column.id);
				}
				return;
			}
			const threadId = rows[cell.row]?.thread.id;
			if (threadId) {
				onOpen(threadId);
			}
			return;
		}
		if (
			cell.row < 0 &&
			column &&
			event.altKey &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		) {
			event.preventDefault();
			const step =
				event.key === "ArrowRight" ? KEY_RESIZE_STEP : -KEY_RESIZE_STEP;
			onResize(
				column.id,
				clampColumnWidth(column.id, widths[column.id] + step)
			);
			return;
		}
		const next = moveSheetCell(cell, event, rows.length);
		if (!next) {
			return;
		}
		event.preventDefault();
		focusCell(next);
		// With a thread open, the panel follows the cursor row the way an
		// expanded record does, matching a click on another row.
		const nextThreadId = rows[next.row]?.thread.id;
		if (
			openThreadId !== null &&
			next.row !== cell.row &&
			nextThreadId &&
			nextThreadId !== openThreadId
		) {
			onOpen(nextThreadId);
		}
	};

	const onFocus = (event: FocusEvent<HTMLTableElement>) => {
		const cell = cellFromTarget(event.target);
		if (
			cell &&
			(!cursorActive || cell.row !== cursor.row || cell.col !== cursor.col)
		) {
			onCursor(cell);
		}
	};

	const onClick = (event: MouseEvent<HTMLTableElement>) => {
		if (event.target instanceof Element && event.target.closest("button")) {
			return;
		}
		const cell = cellFromTarget(event.target);
		if (!cell || cell.row < 0) {
			return;
		}
		// A double click opens, as does a single click while a thread is already
		// showing, so the panel follows the selection like a record preview.
		const threadId = rows[cell.row]?.thread.id;
		if (threadId && (event.detail >= 2 || openThreadId !== null)) {
			onOpen(threadId);
		}
	};

	const showSkeleton = loading && rows.length === 0;

	return (
		<table
			aria-busy={loading}
			aria-colcount={SHEET_COLUMNS.length}
			aria-describedby={describedBy}
			aria-label="Threads"
			aria-rowcount={rows.length + 1}
			className="table-fixed border-separate border-spacing-0"
			data-testid="sheet-grid"
			onClick={onClick}
			onFocus={onFocus}
			onKeyDown={onKeyDown}
			ref={gridRef}
			// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA permits role="grid" on a table; it makes the cells one roving-focus widget (APG data grid).
			role="grid"
			style={{ minWidth: totalWidth, width: "100%" }}
		>
			<colgroup>
				<col style={{ width: SHEET_GUTTER_WIDTH }} />
				{SHEET_COLUMNS.map((column) => (
					<col key={column.id} style={{ width: widths[column.id] }} />
				))}
				<col />
			</colgroup>
			<thead>
				<tr aria-rowindex={1}>
					<td
						aria-hidden="true"
						className={cn(
							CELL,
							HEADER_EDGE,
							"sticky top-0 left-0 z-30 bg-muted px-0"
						)}
					/>
					{SHEET_COLUMNS.map((column, index) => (
						<HeaderCell
							column={column}
							cursor={cursor.row === -1 && cursor.col === index}
							index={index}
							key={column.id}
							onResize={onResize}
							onSort={onSort}
							sort={sort}
							width={widths[column.id]}
						/>
					))}
					<td
						aria-hidden="true"
						className={cn(
							HEADER_EDGE,
							"sticky top-0 z-20 border-border border-b bg-muted"
						)}
					/>
				</tr>
			</thead>
			<tbody>
				{showSkeleton
					? SKELETON_ROWS.map((key, index) => (
							<SkeletonRow index={index} key={key} />
						))
					: rows.map((row, index) => (
							<SheetGridRow
								animate={animate}
								cursorActive={cursorActive}
								cursorCol={cursor.row === index ? cursor.col : null}
								index={index}
								key={row.thread.id}
								now={now}
								onOpen={onOpen}
								open={row.thread.id === openThreadId}
								query={query}
								row={row}
							/>
						))}
			</tbody>
		</table>
	);
}
