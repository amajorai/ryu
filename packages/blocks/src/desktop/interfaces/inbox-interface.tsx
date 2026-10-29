import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { SquarePen } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { InboxDetail, InboxIdle, isEditableTarget } from "./inbox-detail.tsx";
import { InboxTooltipKbd } from "./inbox-kbd.tsx";
import {
	buildInboxModel,
	type InboxItem,
	inboxItem,
	inboxNeighbours,
} from "./inbox-model.ts";
import { InboxRow } from "./inbox-row.tsx";
import { InboxSkeleton } from "./inbox-skeleton.tsx";
import { InboxStatusIcon } from "./inbox-status.tsx";
import { useAutoOpenFirstThread } from "./interface-auto-open.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

const MINUTE = 60_000;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

function needsYouSummary(count: number, total: number): string {
	if (total === 0) {
		return "No threads yet";
	}
	return count === 0 ? "All caught up" : `${count} need you`;
}

type CursorStep = "first" | "last" | "next" | "previous";

/**
 * Keys that move the cursor. J/K work anywhere in the inbox; arrows and
 * Home/End only on a row, so they keep scrolling the conversation elsewhere.
 */
function cursorStep(key: string, onRow: boolean): CursorStep | null {
	switch (key) {
		case "j":
			return "next";
		case "k":
			return "previous";
		case "ArrowDown":
			return onRow ? "next" : null;
		case "ArrowUp":
			return onRow ? "previous" : null;
		case "Home":
			return onRow ? "first" : null;
		case "End":
			return onRow ? "last" : null;
		default:
			return null;
	}
}

function stepIndex(step: CursorStep, index: number, length: number): number {
	switch (step) {
		case "first":
			return 0;
		case "last":
			return length - 1;
		case "next":
			return Math.min(index + 1, length - 1);
		default:
			return Math.max(index - 1, 0);
	}
}

/** Widgets inside the host's chat that own their own letter/arrow keys. */
const KEY_OWNING_WIDGETS =
	'[role="menu"],[role="menubar"],[role="listbox"],[role="combobox"],[role="dialog"],[role="tablist"],[role="radiogroup"],[role="slider"],[role="grid"],[role="tree"]';

/** True when the key event started inside the host's chat surface. */
function inHostChat(target: EventTarget): boolean {
	return (
		target instanceof Element && target.closest("[data-inbox-host]") !== null
	);
}

/** The inbox row a key event started on, if any. */
function rowIdOf(target: EventTarget): string | undefined {
	return target instanceof HTMLElement ? target.dataset.inboxRow : undefined;
}

/**
 * Inbox interface: triage every thread by what needs you, like an email
 * client. The left list is a keyboard-first listbox grouped by urgency
 * (`projectInbox`); the right pane shows the host's real conversation surface
 * for the open thread. Below 900px wide it becomes list/detail navigation.
 */
export function InboxInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["inbox"]>) {
	const model = useMemo(() => buildInboxModel(snapshot), [snapshot]);
	const now = useMinuteClock();
	const [cursorId, setCursorId] = useState<string | null>(null);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const rootRef = useRef<HTMLDivElement>(null);
	const listPane = useRef<HTMLDivElement>(null);
	const detailPane = useRef<HTMLElement>(null);
	const restoreListFocus = useRef(false);

	const detailOpen = threadView !== null && threadView !== undefined;
	const total = model.order.length;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeItem = activeThread ? inboxItem(snapshot, activeThread) : null;

	// The cursor is the focusable row: the last one the user moved to, else the
	// open thread, else the most urgent thread.
	let cursor: string | null = model.order[0] ?? null;
	if (cursorId && model.order.includes(cursorId)) {
		cursor = cursorId;
	} else if (activeThreadId && model.order.includes(activeThreadId)) {
		cursor = activeThreadId;
	}

	useEffect(() => {
		if (activeThreadId) {
			setCursorId(activeThreadId);
		}
	}, [activeThreadId]);

	// Narrow layout hides the list while a thread is open: move focus into the
	// detail pane on open, and back onto the cursor row once it closes.
	useEffect(() => {
		if (detailOpen) {
			const listHidden = listPane.current?.offsetParent === null;
			if (listHidden) {
				detailPane.current?.focus({ preventScroll: true });
			}
			return;
		}
		if (restoreListFocus.current && cursor) {
			restoreListFocus.current = false;
			rowElements.current.get(cursor)?.focus({ preventScroll: true });
		}
	}, [detailOpen, cursor]);

	// Keyboard-first: once rows exist, J/K and Enter should work without a
	// click first. Only take focus nobody holds; never steal it from an input
	// or the host's composer.
	const hasRows = model.order.length > 0;
	const initialFocusDone = useRef(false);
	useEffect(() => {
		if (initialFocusDone.current || loading || !hasRows || !cursor) {
			return;
		}
		initialFocusDone.current = true;
		const row = rowElements.current.get(cursor);
		// Reveal the open thread's row when it starts below the fold.
		row?.scrollIntoView({ block: "nearest" });
		const active = document.activeElement;
		if (active === null || active === document.body) {
			row?.focus({ preventScroll: true });
		}
	}, [cursor, hasRows, loading]);

	const registerRow = useCallback(
		(threadId: string, element: HTMLElement | null) => {
			if (element) {
				rowElements.current.set(threadId, element);
			} else {
				rowElements.current.delete(threadId);
			}
		},
		[]
	);

	const listVisible = () => listPane.current?.offsetParent !== null;

	/** Point the cursor at a row; focus it when keyboard focus is in the list. */
	const moveTo = (threadId: string | undefined, focusRow: boolean) => {
		if (!threadId) {
			return;
		}
		setCursorId(threadId);
		const element = rowElements.current.get(threadId);
		if (focusRow) {
			element?.focus({ preventScroll: true });
		}
		element?.scrollIntoView({ block: "nearest" });
	};

	const openThread = (threadId: string) => {
		setCursorId(threadId);
		port.openThread(threadId);
	};

	useAutoOpenFirstThread({
		activeThreadId,
		firstThreadId: model.order[0] ?? null,
		loading,
		minWidth: 900,
		openThread,
		rootRef,
		threadView,
	});

	const closeThread = () => {
		restoreListFocus.current = true;
		port.closeThread();
	};

	const startThread = () => port.startThread({});

	const neighbours = inboxNeighbours(model.order, activeThreadId);

	/** Prev/next from the detail header: open the neighbour and reveal its row. */
	const openNeighbour = (threadId: string | undefined) => {
		if (!threadId) {
			return;
		}
		openThread(threadId);
		moveTo(threadId, false);
		const after = inboxNeighbours(model.order, threadId);
		if (!(after.previous && after.next)) {
			// The button the user pressed is about to disable; keep focus inside
			// the inbox so J/K keep working.
			detailPane.current?.focus({ preventScroll: true });
		}
	};

	/**
	 * One keyboard handler for the whole inbox, so the advertised shortcuts
	 * work from the list and from the open conversation alike. Typing, the
	 * host chat's own widgets, and modified keys are left alone.
	 */
	const onKeyDownRoot = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			isEditableTarget(event.target) ||
			!(event.target instanceof Node) ||
			!event.currentTarget.contains(event.target)
		) {
			return;
		}
		const rowId = rowIdOf(event.target);
		const onRow = rowId !== undefined;
		if (
			!onRow &&
			event.target instanceof Element &&
			event.target.closest(KEY_OWNING_WIDGETS)
		) {
			return;
		}
		const step = cursorStep(event.key, onRow);
		if (step && model.order.length > 0) {
			event.preventDefault();
			const from = rowId ?? (detailOpen ? activeThreadId : null) ?? cursor;
			const index = from ? model.order.indexOf(from) : -1;
			const target =
				model.order[
					index === -1 && step === "next"
						? 0
						: stepIndex(step, index, model.order.length)
				];
			if (!target) {
				return;
			}
			const listShown = listVisible();
			moveTo(target, onRow && listShown);
			// Triage flow: with a thread open, moving the cursor opens the next
			// one, so the cursor and the conversation never drift apart.
			if (detailOpen && target !== activeThreadId) {
				openThread(target);
				if (!listShown) {
					detailPane.current?.focus({ preventScroll: true });
				}
			}
			return;
		}
		switch (event.key) {
			case "Enter":
			case " ":
			case "o":
				if (rowId) {
					event.preventDefault();
					openThread(rowId);
				}
				return;
			case "Escape":
				if (onRow && detailOpen) {
					event.preventDefault();
					closeThread();
				}
				return;
			case "c":
				if (inHostChat(event.target)) {
					return;
				}
				event.preventDefault();
				startThread();
				return;
			default:
		}
	};

	let cursorItem: InboxItem | null = null;
	for (const section of model.sections) {
		cursorItem =
			section.items.find((item) => item.thread.id === cursor) ?? cursorItem;
	}

	const summary = needsYouSummary(model.needsYou.length, total);

	// Right pane: the open thread, else a calm idle state. Stay blank while the
	// first load is in flight so we never claim "nothing needs you" too early.
	let detailPaneContent: ReactNode = (
		<InboxIdle
			cursorItem={cursorItem}
			empty={!loading && total === 0}
			now={now}
			onOpen={openThread}
			onStart={startThread}
		/>
	);
	if (detailOpen) {
		detailPaneContent = (
			<InboxDetail
				item={activeItem}
				onClose={closeThread}
				onNext={
					neighbours.next ? () => openNeighbour(neighbours.next) : undefined
				}
				onPrevious={
					neighbours.previous
						? () => openNeighbour(neighbours.previous)
						: undefined
				}
				ref={detailPane}
				threadView={threadView}
			/>
		);
	} else if (loading && total === 0) {
		detailPaneContent = <div className="h-full" data-testid="inbox-idle" />;
	}

	return (
		<div
			className="@container flex size-full min-h-0 bg-background text-foreground"
			data-testid="interface-inbox"
			onKeyDown={onKeyDownRoot}
			ref={rootRef}
		>
			<div
				className={cn(
					"@min-[900px]:flex min-h-0 @min-[900px]:w-[400px] w-full shrink-0 flex-col border-border @min-[900px]:border-r bg-sidebar text-sidebar-foreground",
					detailOpen ? "hidden" : "flex"
				)}
				ref={listPane}
			>
				<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
					<div className="flex min-w-0 flex-1 items-baseline gap-2">
						<h2 className="font-semibold text-base text-sidebar-foreground">
							Inbox
						</h2>
						<p
							aria-live="polite"
							className="truncate text-muted-foreground text-sm tabular-nums"
							data-testid="inbox-summary"
						>
							{loading ? "Loading…" : summary}
						</p>
					</div>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label="New thread"
									onClick={startThread}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<SquarePen aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							New thread <InboxTooltipKbd>C</InboxTooltipKbd>
						</TooltipContent>
					</Tooltip>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					{loading && total === 0 ? <InboxSkeleton /> : null}
					{!loading && total === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
							<p className="text-muted-foreground text-sm">
								No threads yet. Start one with any agent.
							</p>
							<Button
								className="@min-[900px]:hidden"
								onClick={startThread}
								size="sm"
								variant="outline"
							>
								New thread
							</Button>
						</div>
					) : null}
					{total > 0 ? (
						<div
							aria-busy={loading}
							aria-label="Inbox threads"
							className="flex flex-col pb-3"
							data-testid="inbox-list"
							role="listbox"
						>
							{model.sections.map((section, sectionIndex) => {
								const headingId = `inbox-section-${section.id}`;
								return (
									<div
										aria-labelledby={headingId}
										className="flex flex-col"
										data-section={section.id}
										key={section.id}
										role="group"
									>
										<div
											aria-hidden="true"
											className={cn(
												"sticky top-0 z-10 flex items-center gap-3 bg-sidebar pr-4 pl-5 text-xs",
												// Later groups get a 8px break above, so a header
												// never reads as part of the row before it.
												sectionIndex === 0 ? "h-8" : "h-10 pt-2"
											)}
											id={headingId}
										>
											{/* Glyph centred in the avatar column; label on the title edge. */}
											<span className="flex w-6 shrink-0 justify-center">
												<InboxStatusIcon
													className="size-3.5 text-muted-foreground"
													status={section.id}
												/>
											</span>
											<span className="flex min-w-0 items-baseline gap-2">
												<span className="font-semibold text-[13px] text-sidebar-foreground">
													{section.label}
												</span>
												<span className="text-muted-foreground tabular-nums">
													{section.items.length}
												</span>
											</span>
										</div>
										<div className="flex flex-col">
											{section.items.map((item) => (
												<InboxRow
													cursor={item.thread.id === cursor}
													item={item}
													key={item.thread.id}
													now={now}
													onFocusRow={setCursorId}
													onOpen={openThread}
													open={item.thread.id === activeThreadId}
													registerRow={registerRow}
												/>
											))}
										</div>
									</div>
								);
							})}
						</div>
					) : null}
				</div>
			</div>

			<div
				className={cn(
					"@min-[900px]:flex min-h-0 min-w-0 flex-1 flex-col",
					detailOpen ? "flex" : "hidden"
				)}
			>
				{detailPaneContent}
			</div>
		</div>
	);
}
