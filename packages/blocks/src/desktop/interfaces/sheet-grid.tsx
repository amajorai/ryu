import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import {
	ArrowDown,
	ArrowUp,
	CircleDot,
	Clock3,
	FolderKanban,
	Hash,
	type LucideIcon,
	Maximize2,
	MessageSquareText,
	SquareCheck,
	Type,
	Users,
	UsersRound,
} from "lucide-react";
import { motion } from "motion/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	memo,
	type PointerEvent,
	type ReactNode,
	type RefObject,
	useRef,
	useState,
} from "react";
import {
	SheetAgents,
	SheetChip,
	SheetHighlight,
	SheetLastMessage,
	SheetPinned,
	SheetStatusPill,
	SheetStatusShare,
	SheetUpdated,
} from "./sheet-cells.tsx";
import {
	clampColumnWidth,
	moveSheetCell,
	SHEET_COLUMNS,
	SHEET_GUTTER_WIDTH,
	type SheetCell,
	type SheetColumn,
	type SheetColumnId,
	type SheetRow,
	type SheetSort,
	type SheetTotals,
	type SheetWidths,
} from "./sheet-model.ts";

export const SHEET_COLUMN_ICON: Record<SheetColumnId, LucideIcon> = {
	agents: Users,
	lastMessage: MessageSquareText,
	messages: Hash,
	pinned: SquareCheck,
	project: FolderKanban,
	status: CircleDot,
	team: UsersRound,
	title: Type,
	updated: Clock3,
};

/** Left offset that centres the 24px expand button in the gutter, from the Title cell. */
const EXPAND_OFFSET = -(SHEET_GUTTER_WIDTH + 24) / 2;
/** Header row height; the body rows match it. */
const ROW_HEIGHT = 32;
/** Pixels an Alt+Arrow press widens or narrows the focused column. */
const KEY_RESIZE_STEP = 16;
/** Above this many rows, sorting snaps instead of animating. */
const ANIMATED_ROW_LIMIT = 80;
const SKELETON_ROWS = [
	"skeleton-1",
	"skeleton-2",
	"skeleton-3",
	"skeleton-4",
	"skeleton-5",
	"skeleton-6",
	"skeleton-7",
	"skeleton-8",
	"skeleton-9",
	"skeleton-10",
	"skeleton-11",
	"skeleton-12",
] as const;
const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5", "w-3/5"] as const;

const CELL =
	"h-8 whitespace-nowrap border-border border-r border-b px-2.5 text-[13px]";
/**
 * Row fills are mixed against the background, so they stay opaque: the frozen
 * gutter and Title cells tint without showing what scrolls under them.
 */
const ROW_FILL = {
	hover:
		"group-hover/row:bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))]",
	open: "bg-[color-mix(in_oklab,var(--primary)_14%,var(--background))] dark:bg-[color-mix(in_oklab,var(--primary)_20%,var(--background))]",
	rest: "bg-background",
	selected:
		"bg-[color-mix(in_oklab,var(--primary)_8%,var(--background))] dark:bg-[color-mix(in_oklab,var(--primary)_11%,var(--background))]",
} as const;
/** Spreadsheet active cell: a solid outline on focus, a faint one while the grid is blurred. */
const CELL_FOCUS =
	"focus:outline-2 focus:-outline-offset-2 focus:outline-primary data-[cursor=true]:not-focus:outline-1 data-[cursor=true]:not-focus:-outline-offset-1 data-[cursor=true]:not-focus:outline-primary/60";
/** Headers only ring for keyboard focus, so a sort click leaves no box behind. */
const HEADER_FOCUS =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary";
/** The freeze line: a firmer divider always, plus a cast shadow once the body scrolls under it. */
const FROZEN_EDGE =
	"border-r-foreground/15 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-3 after:translate-x-full after:bg-linear-to-r after:from-foreground/16 after:to-transparent after:opacity-0 after:transition-opacity group-data-[scrolled-x=true]/sheet:border-r-foreground/25 group-data-[scrolled-x=true]/sheet:after:opacity-100";
const HEADER_EDGE =
	"before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-2.5 before:translate-y-full before:bg-linear-to-b before:from-foreground/12 before:to-transparent before:opacity-0 before:transition-opacity group-data-[scrolled-y=true]/sheet:before:opacity-100";

const ALIGN: Record<SheetColumn["align"], string> = {
	center: "justify-center text-center",
	end: "justify-end text-right",
	start: "justify-start text-left",
};

function rowTint(selected: boolean, open: boolean): string {
	if (open) {
		return ROW_FILL.open;
	}
	if (selected) {
		return ROW_FILL.selected;
	}
	return cn(ROW_FILL.rest, ROW_FILL.hover);
}

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

function SortGlyph({ sort }: { sort: SheetSort | null }) {
	if (!sort) {
		return null;
	}
	const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
	return (
		<Icon aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
	);
}

function ResizeHandle({
	column,
	onResize,
	width,
}: {
	column: SheetColumn;
	onResize: (id: SheetColumnId, width: number) => void;
	width: number;
}) {
	const drag = useRef<{ startWidth: number; startX: number } | null>(null);
	// While dragging, the guide runs the full visible height of the sheet so the
	// edge can be lined up against the cells below, as in a spreadsheet.
	const [guideHeight, setGuideHeight] = useState<number | null>(null);
	const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startWidth: width, startX: event.clientX };
		event.currentTarget.dataset.dragging = "true";
		const scroller = event.currentTarget.closest<HTMLElement>(
			"[data-sheet-scroll]"
		);
		setGuideHeight(scroller?.clientHeight ?? null);
	};
	const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
		const start = drag.current;
		if (!start) {
			return;
		}
		onResize(
			column.id,
			clampColumnWidth(
				column.id,
				start.startWidth + event.clientX - start.startX
			)
		);
	};
	const onPointerEnd = (event: PointerEvent<HTMLSpanElement>) => {
		drag.current = null;
		delete event.currentTarget.dataset.dragging;
		setGuideHeight(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};
	return (
		<span
			aria-hidden="true"
			className="group/resize absolute inset-y-0 right-0 z-10 flex w-2 translate-x-1/2 cursor-col-resize touch-none justify-center"
			data-sheet-resize=""
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => {
				event.stopPropagation();
				onResize(column.id, column.defaultWidth);
			}}
			onPointerCancel={onPointerEnd}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
		>
			<span className="h-full w-0.5 rounded-full bg-primary opacity-0 transition-opacity group-hover/resize:opacity-60 group-data-[dragging=true]/resize:opacity-100" />
			{guideHeight === null ? null : (
				<span
					className="pointer-events-none absolute top-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary"
					data-sheet-resize-guide=""
					style={{ height: guideHeight }}
				/>
			)}
		</span>
	);
}

function HeaderCell({
	column,
	cursor,
	index,
	onResize,
	onSort,
	sort,
	width,
}: {
	column: SheetColumn;
	cursor: boolean;
	index: number;
	onResize: (id: SheetColumnId, width: number) => void;
	onSort: (id: SheetColumnId) => void;
	sort: SheetSort | null;
	width: number;
}) {
	const Icon = SHEET_COLUMN_ICON[column.id];
	const active = sort?.column === column.id ? sort : null;
	let ariaSort: "ascending" | "descending" | "none" = "none";
	if (active) {
		ariaSort = active.direction === "asc" ? "ascending" : "descending";
	}
	const frozen = column.id === "title";
	return (
		<th
			aria-colindex={index + 1}
			aria-sort={ariaSort}
			className={cn(
				CELL,
				HEADER_EDGE,
				HEADER_FOCUS,
				"sticky top-0 z-20 cursor-pointer select-none bg-muted font-normal text-foreground/85 text-xs transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_5%,var(--muted))] hover:text-foreground",
				active && "text-foreground",
				index === SHEET_COLUMNS.length - 1 && "border-r-0",
				frozen && cn("z-30", FROZEN_EDGE)
			)}
			data-sheet-col={index}
			data-sheet-row={-1}
			onClick={() => onSort(column.id)}
			scope="col"
			style={frozen ? { left: SHEET_GUTTER_WIDTH } : undefined}
			tabIndex={cursor ? 0 : -1}
		>
			<div
				className={cn("flex min-w-0 items-center gap-1.5", ALIGN[column.align])}
			>
				{active ? (
					<SortGlyph sort={active} />
				) : (
					<Icon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				)}
				<span className="truncate">{column.label}</span>
			</div>
			<ResizeHandle column={column} onResize={onResize} width={width} />
		</th>
	);
}

function BodyCell({
	children,
	column,
	cursorActive,
	cursorCol,
	index,
	open,
	rowIndex,
	selected,
}: {
	children: ReactNode;
	column: SheetColumn;
	cursorActive: boolean;
	cursorCol: number | null;
	index: number;
	open: boolean;
	rowIndex: number;
	selected: boolean;
}) {
	const cursor = cursorCol === index;
	const frozen = column.id === "title";
	const Tag = frozen ? "th" : "td";
	return (
		<Tag
			aria-colindex={index + 1}
			className={cn(
				CELL,
				CELL_FOCUS,
				rowTint(selected, open),
				index === SHEET_COLUMNS.length - 1 && "border-r-0",
				"font-normal text-foreground",
				frozen && cn("sticky z-10", FROZEN_EDGE)
			)}
			data-cursor={cursorActive && cursor}
			data-sheet-col={index}
			data-sheet-row={rowIndex}
			role={frozen ? "rowheader" : "gridcell"}
			scope={frozen ? "row" : undefined}
			style={frozen ? { left: SHEET_GUTTER_WIDTH } : undefined}
			tabIndex={cursor ? 0 : -1}
		>
			<div
				className={cn(
					"flex min-w-0 items-center overflow-hidden",
					ALIGN[column.align]
				)}
			>
				{children}
			</div>
		</Tag>
	);
}

interface SheetGridRowProps {
	animate: boolean;
	/** False until the user has moved the cursor, so nothing looks selected on first paint. */
	cursorActive: boolean;
	cursorCol: number | null;
	index: number;
	now: number;
	onOpen: (threadId: string) => void;
	open: boolean;
	query: string;
	row: SheetRow;
}

const SheetGridRow = memo(function SheetGridRowImpl({
	animate,
	cursorActive,
	cursorCol,
	index,
	now,
	onOpen,
	open,
	query,
	row,
}: SheetGridRowProps) {
	const selected = cursorActive && cursorCol !== null;
	const cellFor = (column: SheetColumn): ReactNode => {
		switch (column.id) {
			case "title":
				return (
					<>
						<span className="min-w-0 flex-1 truncate font-medium">
							<SheetHighlight query={query} text={row.title} />
						</span>
						{/* Sits over the row-number gutter, which hides its number on hover, so the title keeps its width. */}
						<button
							aria-label={`Open ${row.title}`}
							className="absolute top-1/2 hidden size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring group-hover/row:flex"
							onClick={() => onOpen(row.thread.id)}
							onMouseDown={(event) => event.preventDefault()}
							style={{ left: EXPAND_OFFSET }}
							tabIndex={-1}
							type="button"
						>
							<Maximize2 aria-hidden="true" className="size-3.5" />
						</button>
					</>
				);
			case "status":
				return <SheetStatusPill status={row.status} />;
			case "agents":
				return <SheetAgents agents={row.agents} query={query} />;
			case "team":
				return <SheetChip kind="team" name={row.team} query={query} />;
			case "project":
				return <SheetChip kind="project" name={row.project} query={query} />;
			case "messages":
				return (
					<span className="text-foreground/85 tabular-nums">
						{row.thread.messageCount.toLocaleString()}
					</span>
				);
			case "lastMessage":
				return <SheetLastMessage query={query} row={row} />;
			case "updated":
				return <SheetUpdated now={now} row={row} />;
			case "pinned":
				return <SheetPinned pinned={row.thread.pinned} />;
			default:
				return null;
		}
	};
	return (
		<motion.tr
			aria-rowindex={index + 2}
			aria-selected={selected}
			className="group/row"
			data-open={open}
			data-thread-id={row.thread.id}
			layout={animate ? "position" : false}
			transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
		>
			<td
				aria-hidden="true"
				className={cn(
					CELL,
					rowTint(selected, open),
					"sticky left-0 z-10 px-0 text-center text-muted-foreground text-xs tabular-nums",
					(selected || open) && "text-foreground"
				)}
			>
				<span className="group-hover/row:invisible">{index + 1}</span>
			</td>
			{SHEET_COLUMNS.map((column, colIndex) => (
				<BodyCell
					column={column}
					cursorActive={cursorActive}
					cursorCol={cursorCol}
					index={colIndex}
					key={column.id}
					open={open}
					rowIndex={index}
					selected={selected}
				>
					{cellFor(column)}
				</BodyCell>
			))}
			<td
				aria-hidden="true"
				className={cn("border-border border-b", rowTint(selected, open))}
			/>
		</motion.tr>
	);
});

function SkeletonRow({ index }: { index: number }) {
	return (
		<tr>
			<td
				aria-hidden="true"
				className={cn(CELL, "sticky left-0 z-10 bg-background px-0")}
			>
				<span className="flex justify-center">
					<Skeleton className="h-2 w-3" />
				</span>
			</td>
			{SHEET_COLUMNS.map((column, colIndex) => (
				<td
					aria-hidden="true"
					className={cn(
						CELL,
						"bg-background",
						column.id === "title" && cn("sticky z-10", FROZEN_EDGE),
						colIndex === SHEET_COLUMNS.length - 1 && "border-r-0"
					)}
					key={column.id}
					style={
						column.id === "title" ? { left: SHEET_GUTTER_WIDTH } : undefined
					}
				>
					<Skeleton
						className={cn(
							"h-2.5",
							SKELETON_WIDTHS[(index + colIndex) % SKELETON_WIDTHS.length]
						)}
					/>
				</td>
			))}
			<td aria-hidden="true" className="border-border border-b bg-background" />
		</tr>
	);
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

/**
 * The summary row closing the records, the way a grid tool totals each field
 * in place: every value sits under its own column and scrolls sideways with
 * the grid, and it sticks to the bottom edge once the rows overflow.
 */
export function SheetSummaryBar({
	countLabel,
	statusCounts,
	totals,
	widths,
}: {
	/** "10 threads", or "2 of 10 threads" while a search or filter is on. */
	countLabel: string;
	/** Visible rows per status, for the Status column's share-by-option bar. */
	statusCounts: Record<ThreadStatus, number>;
	totals: SheetTotals;
	widths: SheetWidths;
}) {
	const totalWidth =
		SHEET_GUTTER_WIDTH +
		SHEET_COLUMNS.reduce((sum, column) => sum + widths[column.id], 0);
	const summaryFor = (id: SheetColumnId): ReactNode => {
		if (id === "messages") {
			return (
				<>
					<span className="text-muted-foreground">Sum</span>
					<span className="text-foreground tabular-nums">
						{totals.messages.toLocaleString()}
					</span>
				</>
			);
		}
		if (id === "status") {
			return <SheetStatusShare counts={statusCounts} />;
		}
		if (id === "pinned") {
			return (
				<>
					<span className="text-foreground tabular-nums">{totals.pinned}</span>
					<span className="text-muted-foreground">pinned</span>
				</>
			);
		}
		return null;
	};
	return (
		<div
			className="sticky bottom-0 z-20 flex h-8 w-full border-border border-y bg-background text-xs"
			data-sheet-summary=""
			style={{ minWidth: totalWidth }}
		>
			<p
				aria-live="polite"
				className="sticky left-0 z-10 flex shrink-0 items-center truncate bg-background text-foreground/80 tabular-nums"
				style={{
					paddingInlineStart: SHEET_GUTTER_WIDTH + 10,
					width: SHEET_GUTTER_WIDTH + widths.title,
				}}
			>
				{countLabel}
			</p>
			{SHEET_COLUMNS.filter((column) => column.id !== "title").map((column) => (
				<div
					className={cn(
						"flex min-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap px-2.5",
						ALIGN[column.align]
					)}
					key={column.id}
					style={{ width: widths[column.id] }}
				>
					{summaryFor(column.id)}
				</div>
			))}
		</div>
	);
}
