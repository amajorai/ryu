import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type BoardFilter,
	type BoardParams,
	EMPTY_BOARD_FILTER,
	isBoardFilterEmpty,
	projectBoard,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BOARD_CARD_ATTRIBUTE } from "./board-card.tsx";
import {
	BOARD_LANE_ATTRIBUTE,
	BOARD_LANE_SCROLL_ATTRIBUTE,
	BoardColumnsSkeleton,
	BoardColumnView,
	type BoardStartInput,
} from "./board-column.tsx";
import { BoardDisplayMenu } from "./board-display.tsx";
import { BoardEmptyState } from "./board-empty.tsx";
import {
	BoardFilterBar,
	type BoardFilterField,
	BoardFilterMenu,
	toggleBoardFilter,
} from "./board-filter.tsx";
import {
	BOARD_ROW_ATTRIBUTE,
	BoardListSkeleton,
	BoardListView,
} from "./board-list.tsx";
import { boardBodyState } from "./board-model.ts";
import { BoardCommandPalette } from "./board-palette.tsx";
import { BoardThreadPanel } from "./board-panel.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

type GroupBy = BoardParams["groupBy"];
type View = BoardParams["view"];

const GROUP_REGION_LABEL: Record<GroupBy, string> = {
	agent: "Threads by agent",
	project: "Threads by project",
	status: "Threads by status",
};
/** The command menu's Mod+Shift+K chord as the platform writes it, for its hint. */
const COMMANDS_SHORTCUT =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
		? "⇧⌘K"
		: "Ctrl+Shift+K";
const LIST_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

const NAV_HINT_ID = "board-nav-hint";
/** Slightly longer than the lanes' 200ms width transition. */
const LANE_RESIZE_MS = 240;
/** The board's own padding (p-4), kept to the left of a lane scrolled to start. */
const LANE_INSET = 16;
const ARROW_STEP: Record<string, [column: number, row: number]> = {
	ArrowDown: [0, 1],
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
};

function cardAt(
	root: HTMLElement,
	column: number,
	row: number
): HTMLElement | null {
	return root.querySelector<HTMLElement>(
		`[${BOARD_CARD_ATTRIBUTE}][data-column="${column}"][data-row="${row}"]`
	);
}

function lastRowIn(root: HTMLElement, column: number): number {
	return (
		root.querySelectorAll(`[${BOARD_CARD_ATTRIBUTE}][data-column="${column}"]`)
			.length - 1
	);
}

/**
 * Move focus between cards with the arrow keys: up/down within a lane,
 * left/right to the nearest card in the next non-empty lane.
 */
function moveFocus(
	root: HTMLElement,
	from: HTMLElement,
	key: string,
	columnCount: number
): boolean {
	const step = ARROW_STEP[key];
	if (!step) {
		return false;
	}
	const column = Number(from.dataset.column);
	const row = Number(from.dataset.row);
	if (step[1] !== 0) {
		focusAndReveal(root, cardAt(root, column, row + step[1]));
		return true;
	}
	for (
		let next = column + step[0];
		next >= 0 && next < columnCount;
		next += step[0]
	) {
		const last = lastRowIn(root, next);
		if (last >= 0) {
			focusAndReveal(root, cardAt(root, next, Math.min(row, last)));
			return true;
		}
	}
	return true;
}

function focusCard(root: HTMLElement | null, threadId: string | null) {
	if (!(root && threadId)) {
		return;
	}
	const thread = `[data-thread-id="${CSS.escape(threadId)}"]`;
	const row = root.querySelector<HTMLElement>(
		`${thread} [${BOARD_ROW_ATTRIBUTE}]`
	);
	if (row) {
		focusRow(row);
		return;
	}
	focusAndReveal(
		root,
		root.querySelector<HTMLElement>(`${thread} [${BOARD_CARD_ATTRIBUTE}]`)
	);
}

/** Focus a list row and scroll it just into view below the sticky header. */
function focusRow(row: HTMLElement | null) {
	if (!row) {
		return;
	}
	row.focus({ preventScroll: true });
	row.closest("li")?.scrollIntoView({ block: "nearest" });
}

/** Move between list rows: arrows or J/K, plus Home and End. */
function moveRow(root: HTMLElement, from: HTMLElement, key: string): boolean {
	const rows = root.querySelectorAll<HTMLElement>(`[${BOARD_ROW_ATTRIBUTE}]`);
	const index = Number(from.dataset.index);
	let next: number | null = null;
	if (key === "Home") {
		next = 0;
	} else if (key === "End") {
		next = rows.length - 1;
	} else if (LIST_STEP[key] !== undefined) {
		next = Math.min(rows.length - 1, Math.max(0, index + LIST_STEP[key]));
	}
	if (next === null) {
		return false;
	}
	focusRow(rows[next] ?? null);
	return true;
}

/** Whether a key event comes from somewhere the user is typing. */
function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** How far `inner` sits outside `outer`'s visible span (0 when inside). */
function overflowBy(
	inner: { end: number; start: number },
	outer: { end: number; start: number },
	inset: number
): number {
	if (inner.start < outer.start + inset) {
		return inner.start - outer.start - inset;
	}
	if (inner.end > outer.end - inset) {
		return Math.min(
			inner.end - outer.end + inset,
			inner.start - outer.start - inset
		);
	}
	return 0;
}

/**
 * Scroll offsets at which a lane sits flush at the board's start (its snap
 * points), clamped to the scrollable range.
 */
function laneStops(board: HTMLElement): number[] {
	const boardLeft = board.getBoundingClientRect().left;
	const max = board.scrollWidth - board.clientWidth;
	return Array.from(
		board.querySelectorAll<HTMLElement>(`[${BOARD_LANE_ATTRIBUTE}]`),
		(lane) => {
			const offset =
				lane.getBoundingClientRect().left -
				boardLeft +
				board.scrollLeft -
				LANE_INSET;
			return Math.min(max, Math.max(0, Math.round(offset)));
		}
	);
}

/**
 * The lane boundary to rest on: the first one at or past `desired` when
 * moving right, the last one at or before it when moving left.
 */
function stopFor(board: HTMLElement, desired: number, forward: boolean) {
	const stops = laneStops(board);
	if (forward) {
		return (
			stops.find((stop) => stop >= desired - 1) ??
			board.scrollWidth - board.clientWidth
		);
	}
	// A reversed copy rather than `findLast`, which the desktop's lib target lacks.
	return [...stops].reverse().find((stop) => stop <= desired + 1) ?? 0;
}

/** Lanes wholly or partly out of view on each side of the board. */
interface LaneOverflow {
	end: number;
	start: number;
}

const NO_OVERFLOW: LaneOverflow = { end: 0, start: 0 };

function laneOverflow(board: HTMLElement): LaneOverflow {
	const boardRect = board.getBoundingClientRect();
	let start = 0;
	let end = 0;
	for (const lane of board.querySelectorAll<HTMLElement>(
		`[${BOARD_LANE_ATTRIBUTE}]`
	)) {
		const rect = lane.getBoundingClientRect();
		if (rect.left < boardRect.left - 1) {
			start += 1;
		} else if (rect.right > boardRect.right + 1) {
			end += 1;
		}
	}
	return { end, start };
}

/** Scroll the board one lane boundary toward `forward`. */
function stepLanes(board: HTMLElement, forward: boolean) {
	const stops = laneStops(board);
	const current = board.scrollLeft;
	const target = forward
		? (stops.find((stop) => stop > current + 1) ??
			board.scrollWidth - board.clientWidth)
		: ([...stops].reverse().find((stop) => stop < current - 1) ?? 0);
	board.scrollTo({ left: target });
}

/**
 * A slim, always-visible strip on the board's edge while lanes sit off that
 * side: a chevron over how many are hidden, so the urgent lanes never vanish
 * without a trace when a thread is open. Clicking steps one lane; arrow keys
 * already reach every lane, so it stays out of the Tab order.
 */
function LaneEdge({
	count,
	onStep,
	side,
}: {
	count: number;
	onStep: () => void;
	side: "end" | "start";
}) {
	const Icon = side === "start" ? ChevronLeft : ChevronRight;
	const label = `Show ${count} ${side === "start" ? "earlier" : "later"} ${count === 1 ? "lane" : "lanes"}`;
	return (
		<button
			aria-label={label}
			className={cn(
				"flex w-8 shrink-0 flex-col items-center border-border bg-background pt-4 text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
				side === "start" ? "border-r" : "border-l"
			)}
			data-board-edge={side}
			onClick={onStep}
			tabIndex={-1}
			title={label}
			type="button"
		>
			<span className="flex h-11 flex-col items-center justify-center gap-0.5">
				<Icon aria-hidden="true" className="size-4" />
				<span className="text-xs tabular-nums leading-4">{count}</span>
			</span>
		</button>
	);
}

/**
 * Bring a card into view by scrolling only the board and its lane — never the
 * page around them, which `scrollIntoView` would also shift. The board always
 * rests on a lane boundary, so no neighbour is left cut off mid-word.
 */
function revealCard(board: HTMLElement, card: HTMLElement) {
	const lane = card.closest<HTMLElement>(`[${BOARD_LANE_ATTRIBUTE}]`) ?? card;
	const boardRect = board.getBoundingClientRect();
	const laneRect = lane.getBoundingClientRect();
	const nearest = overflowBy(
		{ end: laneRect.right, start: laneRect.left },
		{ end: boardRect.right, start: boardRect.left },
		LANE_INSET
	);
	if (nearest !== 0) {
		// Move only as far as needed, so earlier lanes stay in view whenever
		// the card allows it.
		const target = stopFor(board, board.scrollLeft + nearest, nearest > 0);
		board.scrollTo({ left: target });
	}
	const scroller = card.closest<HTMLElement>(
		`[${BOARD_LANE_SCROLL_ATTRIBUTE}]`
	);
	if (!scroller) {
		return;
	}
	const cardRect = card.getBoundingClientRect();
	const scrollerRect = scroller.getBoundingClientRect();
	const top = overflowBy(
		{ end: cardRect.bottom, start: cardRect.top },
		{ end: scrollerRect.bottom, start: scrollerRect.top },
		8
	);
	if (top !== 0) {
		scroller.scrollTo({ top: scroller.scrollTop + top });
	}
}

/** Focus a card's button without letting the browser scroll the page. */
function focusAndReveal(root: HTMLElement, button: HTMLElement | null) {
	if (!button) {
		return;
	}
	button.focus({ preventScroll: true });
	const card = button.closest<HTMLElement>("[data-thread-id]");
	if (card) {
		revealCard(root, card);
	}
}

/**
 * Board: every thread as a Kanban board or a dense, grouped list. Groups come
 * from `projectBoard` — by status (most urgent first), agent, or project —
 * narrowed by filters. Status is derived from the conversation itself, so
 * cards are not draggable; opening one keeps the board in view and shows the
 * host's real conversation in a side panel. Mod+Shift+K opens the command
 * menu; Mod+K stays the desktop's own command palette.
 */
export function BoardInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<BoardParams>) {
	const [groupBy, setGroupBy] = useInterfaceSetting<GroupBy>(
		port,
		"groupBy",
		params.groupBy
	);
	const [view, setView] = useInterfaceSetting<View>(port, "view", params.view);
	const [filter, setFilter] = useState<BoardFilter>(EMPTY_BOARD_FILTER);
	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [paletteOpen, setPaletteOpen] = useState(false);

	const columns = useMemo(
		() => projectBoard(snapshot, { filter, groupBy }),
		[snapshot, groupBy, filter]
	);
	const threadsById = useMemo(
		() => new Map(snapshot.threads.map((thread) => [thread.id, thread])),
		[snapshot.threads]
	);
	const now = Date.now();
	const workingCount = snapshot.threads.filter(
		(thread) => threadStatus(thread) === "working"
	).length;
	const shownCount = columns.reduce(
		(total, column) => total + column.threadIds.length,
		0
	);
	const filtered = !isBoardFilterEmpty(filter);
	const activeThread = activeThreadId
		? threadsById.get(activeThreadId)
		: undefined;
	const panelOpen = threadView !== null;
	const isList = view === "list";

	const boardRef = useRef<HTMLDivElement>(null);
	// Keep the selected card or row in view when a thread opens (and on load).
	useEffect(() => {
		const board = boardRef.current;
		if (!(board && activeThreadId)) {
			return;
		}
		const reveal = () => {
			const item = board.querySelector<HTMLElement>(
				`[data-thread-id="${CSS.escape(activeThreadId)}"]`
			);
			if (!item) {
				return;
			}
			if (isList) {
				item.scrollIntoView({ block: "nearest" });
			} else {
				revealCard(board, item);
			}
		};
		const frame = requestAnimationFrame(reveal);
		// Lanes ease to their new width; settle on a lane boundary once they land.
		const settle = window.setTimeout(reveal, LANE_RESIZE_MS);
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(settle);
		};
	}, [activeThreadId, panelOpen, isList]);

	// Which lanes sit off either edge, for the edge strips.
	const [overflow, setOverflow] = useState<LaneOverflow>(NO_OVERFLOW);
	const measureOverflow = useCallback(() => {
		const board = boardRef.current;
		const next = board && !isList ? laneOverflow(board) : NO_OVERFLOW;
		setOverflow((current) =>
			current.start === next.start && current.end === next.end ? current : next
		);
	}, [isList]);
	useEffect(() => {
		const board = boardRef.current;
		measureOverflow();
		if (!board || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measureOverflow);
		observer.observe(board);
		return () => observer.disconnect();
	}, [measureOverflow, columns, panelOpen, loading]);

	// Roving tabindex: the board is one Tab stop; arrows move between items.
	const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
	useEffect(() => {
		if (activeThreadId) {
			setFocusedThreadId(activeThreadId);
		}
	}, [activeThreadId]);
	const reachableThreadIds = useMemo(
		() =>
			columns
				.filter((column) => !(isList && collapsedIds.has(column.id)))
				.flatMap((column) => column.threadIds),
		[columns, isList, collapsedIds]
	);
	const pickTabStop = (): string | null => {
		for (const candidate of [focusedThreadId, activeThreadId]) {
			if (candidate && reachableThreadIds.includes(candidate)) {
				return candidate;
			}
		}
		return reachableThreadIds[0] ?? null;
	};
	const tabStopThreadId = pickTabStop();
	const onBoardFocus = (event: FocusEvent<HTMLDivElement>) => {
		const target = event.target;
		if (
			target.hasAttribute(BOARD_CARD_ATTRIBUTE) ||
			target.hasAttribute(BOARD_ROW_ATTRIBUTE)
		) {
			setFocusedThreadId(
				target.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId ??
					null
			);
		}
	};

	// Closing unmounts the panel's button, so hand focus back to the item at
	// once (the cards stay mounted), then re-reveal it after the lanes widen —
	// unless the user has already moved on with the arrow keys.
	const closeThread = useCallback(() => {
		const closingId = activeThreadId;
		port.closeThread();
		focusCard(boardRef.current, closingId);
		const focused = document.activeElement;
		requestAnimationFrame(() => {
			if (document.activeElement === focused) {
				focusCard(boardRef.current, closingId);
			}
		});
	}, [activeThreadId, port]);

	const startThread = (input: BoardStartInput = {}) => port.startThread(input);
	const toggleFilter = (field: BoardFilterField, value: string) =>
		setFilter((current) => toggleBoardFilter(current, field, value));
	const clearFilters = () => setFilter(EMPTY_BOARD_FILTER);
	const toggleSection = (columnId: string) =>
		setCollapsedIds((current) => {
			const next = new Set(current);
			if (!next.delete(columnId)) {
				next.add(columnId);
			}
			return next;
		});

	const onBoardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const board = boardRef.current;
		const target = event.target;
		if (!(board && target instanceof HTMLElement)) {
			return;
		}
		if (event.key === "Escape" && panelOpen) {
			event.preventDefault();
			closeThread();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const moved = target.hasAttribute(BOARD_ROW_ATTRIBUTE)
			? moveRow(board, target, event.key)
			: target.hasAttribute(BOARD_CARD_ATTRIBUTE) &&
				moveFocus(board, target, event.key, columns.length);
		if (moved) {
			event.preventDefault();
		}
	};

	// Mod+Shift+K opens the Board's command menu when focus is on the board
	// (or nowhere yet, right after switching here). Mod+K is the desktop's
	// command palette and the board leaves it alone, so that palette works here
	// too. The open conversation and anything layered over the board keep the
	// chord to themselves, and a chord something else already handled (its
	// default prevented) is left alone.
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			const root = rootRef.current;
			const target = event.target;
			if (
				!(root && (event.metaKey || event.ctrlKey) && event.shiftKey) ||
				event.altKey ||
				event.defaultPrevented ||
				event.key.toLowerCase() !== "k"
			) {
				return;
			}
			const onBoard =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && root.contains(target));
			const inThread =
				target instanceof Element &&
				target.closest("[data-testid='board-thread-panel']") !== null;
			if (!onBoard || inThread) {
				return;
			}
			event.preventDefault();
			setPaletteOpen((open) => !open);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// C starts a thread from anywhere on the board except where you type.
	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key.toLowerCase() === "c" &&
			!(
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				isTyping(event.target)
			) &&
			!(
				event.target instanceof Element &&
				event.target.closest("[data-testid='board-thread-panel']")
			)
		) {
			event.preventDefault();
			startThread();
		}
	};

	const bodyState = boardBodyState({
		agentCount: snapshot.agents.length,
		filtered,
		groupBy,
		loading,
		shownCount,
		threadCount: snapshot.threads.length,
	});

	let body: ReactNode;
	if (loading) {
		body = isList ? (
			<BoardListSkeleton />
		) : (
			<BoardColumnsSkeleton compact={panelOpen} />
		);
	} else if (isList) {
		body = (
			<BoardListView
				collapsedIds={collapsedIds}
				columns={columns}
				compact={panelOpen}
				groupedByProject={groupBy === "project"}
				now={now}
				onOpen={port.openThread}
				onStart={startThread}
				onToggle={toggleSection}
				selectedThreadId={activeThreadId}
				snapshot={snapshot}
				tabStopThreadId={tabStopThreadId}
				threadsById={threadsById}
			/>
		);
	} else {
		body = columns.map((column, columnIndex) => (
			<BoardColumnView
				activeThreadId={activeThreadId}
				column={column}
				columnIndex={columnIndex}
				compact={panelOpen}
				key={column.id}
				now={now}
				onOpen={port.openThread}
				onStart={startThread}
				snapshot={snapshot}
				tabStopThreadId={tabStopThreadId}
				threadsById={threadsById}
			/>
		));
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the board-wide C shortcut; every control inside stays a native button.
		<div
			className="relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-board"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<header className="@container/header flex h-12 shrink-0 items-center gap-1 border-border border-b pr-3 pl-4">
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="shrink-0 font-heading font-semibold! text-foreground text-sm">
						Board
					</h1>
					{loading ? null : (
						<p className="@max-[480px]/header:hidden truncate text-muted-foreground text-xs tabular-nums">
							{filtered
								? `${shownCount} of ${snapshot.threads.length}`
								: snapshot.threads.length}{" "}
							{snapshot.threads.length === 1 ? "thread" : "threads"}
							{workingCount > 0 ? ` · ${workingCount} working` : ""}
						</p>
					)}
				</div>
				<BoardFilterMenu
					filter={filter}
					onToggle={toggleFilter}
					snapshot={snapshot}
				/>
				<BoardDisplayMenu
					groupBy={groupBy}
					onGroupByChange={setGroupBy}
					onViewChange={setView}
					view={view}
				/>
				<Button
					aria-keyshortcuts="Control+Shift+K Meta+Shift+K"
					aria-label="Commands"
					className="size-7 text-muted-foreground"
					onClick={() => setPaletteOpen(true)}
					size="icon-sm"
					title={`Commands (${COMMANDS_SHORTCUT})`}
					type="button"
					variant="ghost"
				>
					<Search aria-hidden="true" />
				</Button>
				<Button
					aria-keyshortcuts="C"
					aria-label="New thread"
					className="ml-1 @max-[640px]/header:w-7 @max-[640px]/header:px-0"
					onClick={() => startThread()}
					size="compact"
					title="New thread (C)"
					type="button"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className="@max-[640px]/header:hidden">New thread</span>
				</Button>
			</header>
			<BoardFilterBar
				filter={filter}
				onClear={clearFilters}
				onRemoveField={(field) =>
					setFilter((current) => ({ ...current, [field]: [] }))
				}
				snapshot={snapshot}
			/>
			<div className="relative flex min-h-0 flex-1">
				{bodyState === "empty" || bodyState === "no-matches" ? (
					<BoardEmptyState
						kind={bodyState}
						onClearFilters={clearFilters}
						onStart={() => startThread()}
					/>
				) : (
					<div className="relative flex min-w-0 flex-1">
						{overflow.start > 0 ? (
							<LaneEdge
								count={overflow.start}
								onStep={() =>
									boardRef.current && stepLanes(boardRef.current, false)
								}
								side="start"
							/>
						) : null}
						<div
							aria-busy={loading}
							aria-describedby={loading ? undefined : NAV_HINT_ID}
							aria-label={GROUP_REGION_LABEL[groupBy]}
							className={cn(
								isList
									? "@container scroll-fade min-w-0 flex-1 overflow-y-auto"
									: "@container scroll-fade-x flex min-w-0 flex-1 snap-x scroll-pl-4 gap-3 overflow-x-auto p-4",
								!isList && (panelOpen ? "snap-mandatory" : "snap-proximity")
							)}
							onFocus={onBoardFocus}
							onKeyDown={onBoardKeyDown}
							onScroll={isList ? undefined : measureOverflow}
							onTransitionEnd={isList ? undefined : measureOverflow}
							ref={boardRef}
							role="region"
						>
							{body}
							<p className="sr-only" id={NAV_HINT_ID}>
								{isList
									? "Use the arrow keys or J and K to move between threads and Enter to open one."
									: "Use the arrow keys to move between cards and Enter to open one."}{" "}
								Escape closes the open thread.
							</p>
						</div>
						{overflow.end > 0 ? (
							<LaneEdge
								count={overflow.end}
								onStep={() =>
									boardRef.current && stepLanes(boardRef.current, true)
								}
								side="end"
							/>
						) : null}
					</div>
				)}
				{panelOpen ? (
					<BoardThreadPanel
						onClose={closeThread}
						snapshot={snapshot}
						thread={activeThread}
						threadView={threadView}
					/>
				) : null}
			</div>
			{paletteOpen ? (
				<BoardCommandPalette
					actions={{
						clearFilters,
						closeThread,
						openThread: port.openThread,
						setGroupBy,
						setView,
						startThread,
						toggleFilter,
					}}
					filter={filter}
					groupBy={groupBy}
					onOpenChange={setPaletteOpen}
					open={paletteOpen}
					panelOpen={panelOpen}
					snapshot={snapshot}
					view={view}
				/>
			) : null}
		</div>
	);
}
