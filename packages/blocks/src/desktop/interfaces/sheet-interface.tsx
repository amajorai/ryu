import { useLiteralMessages } from "@ryu/i18n/react";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { AnimatePresence, MotionConfig } from "motion/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	SheetGrid,
	type SheetGridCursor,
	SheetSummaryBar,
} from "./sheet-grid.tsx";
import {
	keyIsOurs,
	markScrolled,
	ownsKeys,
	useElementWidth,
	useMinuteClock,
} from "./sheet-interface-dom.ts";
import {
	buildSheetRows,
	countSheetStatuses,
	defaultSheetWidths,
	filterSheetRows,
	nextSheetSort,
	SHEET_GUTTER_WIDTH,
	type SheetColumnId,
	type SheetSort,
	type SheetWidths,
	sheetTotals,
	sortSheetRows,
} from "./sheet-model.ts";
import { SheetThreadPanel } from "./sheet-panel.tsx";
import { SheetStatusBar } from "./sheet-statusbar.tsx";
import { type SheetStartInput, SheetToolbar } from "./sheet-toolbar.tsx";

/** Below this width the default Title column narrows. */
const NARROW_WIDTH = 640;
/** Below this width an open thread covers the grid instead of sitting beside it. */
const OVERLAY_WIDTH = 760;
/** Below this grid width the footer status tabs drop to dot + count. */
const COMPACT_TABS_WIDTH = 672;
/** The cursor key that stands for the header row. */
const HEADER_KEY = "\u0000header";

interface SheetCursorState {
	col: number;
	/** A thread id, or HEADER_KEY for the header row. */
	key: string;
}

/**
 * Sheet: every thread as a row in a spreadsheet grid, Airtable / Google
 * Sheets style. A row-number gutter and the Title column stay frozen while the
 * rest scrolls; headers sort (ascending, descending, off) and resize by
 * dragging their edge; arrow keys move a cell cursor and Enter opens the row's
 * thread beside the grid in the host's real conversation surface. Search and
 * the status tabs in the footer narrow the rows.
 */
export function SheetInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	// The host's "animations off" counts, not only the system preference.
	const reducedMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const gridRef = useRef<HTMLTableElement>(null);
	const gridColumnRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const restoreGridFocus = useRef(false);
	const descriptionId = useId();
	const width = useElementWidth(rootRef);
	const gridWidth = useElementWidth(gridColumnRef);
	const now = useMinuteClock();

	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<ThreadStatus | null>(null);
	const [sort, setSort] = useState<SheetSort | null>(null);
	const [resized, setResized] = useState<Partial<SheetWidths>>({});
	const [cursorState, setCursorState] = useState<SheetCursorState | null>(null);

	const widths = useMemo<SheetWidths>(
		() => ({ ...defaultSheetWidths(width < NARROW_WIDTH), ...resized }),
		[width, resized]
	);
	const allRows = useMemo(() => buildSheetRows(snapshot), [snapshot]);
	const searched = useMemo(
		() => filterSheetRows(allRows, query, null),
		[allRows, query]
	);
	const rows = useMemo(
		() =>
			sortSheetRows(
				status ? searched.filter((row) => row.status === status) : searched,
				sort
			),
		[searched, status, sort]
	);
	const counts = useMemo(() => countSheetStatuses(searched), [searched]);
	const totals = useMemo(() => sheetTotals(rows), [rows]);
	const rowCounts = useMemo(() => countSheetStatuses(rows), [rows]);

	const panelOpen = threadView !== null && threadView !== undefined;
	const openThreadId = panelOpen ? activeThreadId : null;
	const openIndex = openThreadId
		? rows.findIndex((row) => row.thread.id === openThreadId)
		: -1;
	const openRow =
		openIndex >= 0
			? rows[openIndex]
			: allRows.find((row) => row.thread.id === openThreadId);

	// Resolve the cursor against what is on screen: the remembered thread when
	// it is still visible, else the first row (or the header when empty). A
	// cursor whose row a filter hid parks on that fallback without a selection
	// tint, so no row looks chosen until the user moves again.
	let cursor: SheetGridCursor = { col: 0, row: rows.length > 0 ? 0 : -1 };
	let cursorActive = false;
	if (cursorState) {
		const index =
			cursorState.key === HEADER_KEY
				? -1
				: rows.findIndex((row) => row.thread.id === cursorState.key);
		if (index >= 0 || cursorState.key === HEADER_KEY) {
			cursor = { col: cursorState.col, row: index };
			cursorActive = true;
		} else {
			cursor = { ...cursor, col: cursorState.col };
		}
	}

	const focusCursorCell = useCallback(() => {
		const table = gridRef.current;
		const focusable = table?.querySelector<HTMLElement>(
			"[data-sheet-col][tabindex='0']"
		);
		focusable?.focus({ preventScroll: true });
	}, []);

	// Follow the host: when it opens a thread, put the cursor on its row and
	// bring the row into view without stealing focus.
	useEffect(() => {
		if (!activeThreadId) {
			return;
		}
		setCursorState((previous) => ({
			col: previous?.col ?? 0,
			key: activeThreadId,
		}));
		const rowElements =
			gridRef.current?.querySelectorAll<HTMLElement>("tr[data-thread-id]") ??
			[];
		for (const element of rowElements) {
			if (element.dataset.threadId === activeThreadId) {
				element.scrollIntoView?.({ block: "nearest" });
				break;
			}
		}
	}, [activeThreadId]);

	// When the panel closes from the keyboard, hand focus back to the grid.
	useEffect(() => {
		if (!panelOpen && restoreGridFocus.current) {
			restoreGridFocus.current = false;
			focusCursorCell();
		}
	}, [panelOpen, focusCursorCell]);

	// Re-measure the right-edge overflow whenever the grid or its columns change size.
	useLayoutEffect(() => {
		if (scrollRef.current && gridWidth > 0 && widths) {
			markScrolled(scrollRef.current);
		}
	}, [gridWidth, widths]);

	const closeThread = useCallback(() => {
		restoreGridFocus.current = true;
		port.closeThread();
	}, [port]);

	// "/" jumps to search; Escape closes the open thread unless the key belongs
	// to typing or to the host's chat, which keeps its own Escape.
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.defaultPrevented ||
				ownsKeys(event.target) ||
				!keyIsOurs(rootRef.current, event.target)
			) {
				return;
			}
			if (event.key === "/" && !(event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				searchRef.current?.focus();
				searchRef.current?.select();
				return;
			}
			if (event.key === "Escape" && panelOpen) {
				event.preventDefault();
				closeThread();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [panelOpen, closeThread]);

	const openThread = useCallback(
		(threadId: string) => {
			setCursorState((previous) => ({
				col: previous?.col ?? 0,
				key: threadId,
			}));
			port.openThread(threadId);
		},
		[port]
	);

	const onCursor = useCallback(
		(cell: SheetGridCursor) => {
			const key = cell.row < 0 ? HEADER_KEY : rows[cell.row]?.thread.id;
			if (key) {
				setCursorState({ col: cell.col, key });
			}
		},
		[rows]
	);

	const onSort = useCallback((column: SheetColumnId) => {
		setSort((previous) => nextSheetSort(previous, column));
	}, []);

	const onResize = useCallback((column: SheetColumnId, next: number) => {
		setResized((previous) =>
			previous[column] === next ? previous : { ...previous, [column]: next }
		);
	}, []);

	const startThread = (input: SheetStartInput) => port.startThread(input);

	const stepPanel = (offset: -1 | 1) => {
		const next = rows[openIndex + offset];
		if (next) {
			openThread(next.thread.id);
		}
	};

	const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "Enter") {
			event.preventDefault();
			focusCursorCell();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			if (query) {
				setQuery("");
			} else {
				event.currentTarget.blur();
			}
		}
	};

	const trimmedQuery = query.trim();
	const total = snapshot.threads.length;
	const filtered = trimmedQuery !== "" || status !== null;
	const noun = total === 1 ? "thread" : "threads";
	const countLabel = filtered
		? `${rows.length} of ${total} ${noun}`
		: `${total} ${noun}`;
	const showEmpty = !loading && rows.length === 0;

	let empty: React.ReactNode = null;
	if (showEmpty && total === 0) {
		empty = <span className="text-muted-foreground">No threads yet</span>;
	} else if (showEmpty) {
		const statusLabel = status ? THREAD_STATUS_LABELS[status] : "";
		let message = tl("No threads match “{trimmedQuery}”", { trimmedQuery });
		let clearLabel = "Clear search";
		if (status && trimmedQuery) {
			message = tl("No “{statusLabel}” threads match “{trimmedQuery}”", {
				statusLabel,
				trimmedQuery,
			});
			clearLabel = "Clear search and filter";
		} else if (status) {
			message = tl("No threads are “{statusLabel}”", { statusLabel });
			clearLabel = "Clear filter";
		}
		empty = (
			<>
				<span className="truncate text-muted-foreground">{message}</span>
				<button
					className="shrink-0 rounded-xs text-foreground underline decoration-foreground/30 underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => {
						setQuery("");
						setStatus(null);
					}}
					type="button"
				>
					{clearLabel}
				</button>
			</>
		);
	}
	// The add row closes the records, and is the whole call to action on an empty sheet.
	const showAddRow = rows.length > 0 || (showEmpty && total === 0);

	/** Left inset that lines row text up with the Title column's text. */
	const titleInset = SHEET_GUTTER_WIDTH + 10;

	return (
		<MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
			<div
				className="@container/sheet relative flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
				data-testid="interface-sheet"
				ref={rootRef}
			>
				<SheetToolbar
					counts={counts}
					onQueryChange={setQuery}
					onSearchKeyDown={onSearchKeyDown}
					onSort={setSort}
					onStart={startThread}
					onStatus={setStatus}
					query={query}
					searchRef={searchRef}
					snapshot={snapshot}
					sort={sort}
					status={status}
					total={searched.length}
				/>
				<div className="relative flex min-h-0 flex-1">
					<div
						className="@container/grid flex min-w-0 flex-1 flex-col"
						ref={gridColumnRef}
					>
						<p className="sr-only" id={descriptionId}>
							Arrow keys move between cells. Enter opens the row's thread and
							Escape closes it; while a thread is open it follows the row you
							move to. On a column header, Enter sorts, and Alt with Left or
							Right Arrow resizes the column.
						</p>
						<div className="relative flex min-h-0 flex-1 flex-col">
							<div
								className="group/sheet peer/sheet relative min-h-0 flex-1 overflow-auto overscroll-contain bg-muted/70 dark:bg-muted/40"
								data-sheet-scroll=""
								onScroll={(event) => markScrolled(event.currentTarget)}
								ref={scrollRef}
							>
								<SheetGrid
									animateRows
									cursor={cursor}
									cursorActive={cursorActive}
									describedBy={descriptionId}
									gridRef={gridRef}
									loading={loading}
									now={now}
									onCursor={onCursor}
									onOpen={openThread}
									onResize={onResize}
									onSort={onSort}
									openThreadId={openThreadId}
									query={query}
									rows={rows}
									scrollRef={scrollRef}
									sort={sort}
									widths={widths}
								/>
								{empty ? (
									<div
										className="sticky left-0 flex h-8 w-full items-center gap-3 border-border border-b bg-background pe-3 text-[13px]"
										role="status"
										style={{ paddingInlineStart: titleInset }}
									>
										{empty}
									</div>
								) : null}
								{showAddRow ? (
									<button
										className="sticky left-0 flex h-8 w-full items-center bg-background text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:text-foreground"
										onClick={() => startThread({})}
										style={{ paddingInlineStart: titleInset }}
										type="button"
									>
										<span
											aria-hidden="true"
											className="absolute inset-y-0 left-0 flex items-center justify-center"
											style={{ width: SHEET_GUTTER_WIDTH }}
										>
											<Plus className="size-3.5" />
										</span>
										Add thread
									</button>
								) : null}
								{rows.length > 0 ? (
									<SheetSummaryBar
										countLabel={countLabel}
										statusCounts={rowCounts}
										totals={totals}
										widths={widths}
									/>
								) : null}
							</div>
							<span
								aria-hidden="true"
								className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-linear-to-l from-foreground/12 to-transparent opacity-0 transition-opacity peer-data-[overflow-right=true]/sheet:opacity-100"
							/>
						</div>
						<SheetStatusBar
							compact={gridWidth < COMPACT_TABS_WIDTH}
							counts={counts}
							onStatus={setStatus}
							status={status}
							total={searched.length}
						/>
					</div>
					<AnimatePresence initial={false}>
						{panelOpen ? (
							<SheetThreadPanel
								key="sheet-thread-panel"
								onClose={closeThread}
								onStep={stepPanel}
								overlay={width < OVERLAY_WIDTH}
								position={openIndex}
								row={openRow}
								threadView={threadView}
								total={rows.length}
							/>
						) : null}
					</AnimatePresence>
				</div>
			</div>
		</MotionConfig>
	);
}
