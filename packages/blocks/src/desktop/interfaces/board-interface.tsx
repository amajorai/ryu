import { useLiteralMessages } from "@ryu/i18n/react";
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
import { Plus, Search } from "lucide-react";
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
import { useBoardCommandsChord } from "./board-interface-commands-chord.ts";
import {
	COMMANDS_SHORTCUT,
	GROUP_REGION_LABEL,
	type GroupBy,
	type View,
} from "./board-interface-labels.ts";
import { LaneEdge } from "./board-interface-lane-edge.tsx";
import {
	focusCard,
	isTyping,
	LANE_RESIZE_MS,
	type LaneOverflow,
	laneOverflow,
	moveFocus,
	moveRow,
	NAV_HINT_ID,
	NO_OVERFLOW,
	revealCard,
	stepLanes,
} from "./board-interface-navigation.ts";
import {
	BOARD_ROW_ATTRIBUTE,
	BoardListSkeleton,
	BoardListView,
} from "./board-list.tsx";
import { boardBodyState } from "./board-model.ts";
import { BoardCommandPalette } from "./board-palette.tsx";
import { BoardThreadPanel } from "./board-panel.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

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
	const tl = useLiteralMessages();

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

	const rootRef = useRef<HTMLDivElement>(null);
	useBoardCommandsChord(rootRef, setPaletteOpen);

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
							{workingCount > 0
								? ` ${tl("· {workingCount} working", {
										workingCount: String(workingCount),
									})}`
								: ""}
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
					title={tl("Commands ({COMMANDS_SHORTCUT})", { COMMANDS_SHORTCUT })}
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
								{tl("{0} Escape closes the open thread.", {
									0: isList
										? tl(
												"Use the arrow keys or J and K to move between threads and Enter to open one."
											)
										: tl(
												"Use the arrow keys to move between cards and Enter to open one."
											),
								})}
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
