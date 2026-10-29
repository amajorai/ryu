import { cn } from "@ryu/ui/lib/utils";
import {
	type DeskView,
	type InterfaceParamsByRenderer,
	projectDeskViews,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	DeskConversation,
	type DeskNeedsYouHint,
	DeskNoSelection,
} from "./desk-conversation.tsx";
import { DeskDetails } from "./desk-details.tsx";
import { DeskConversationList, deskCursorStep } from "./desk-list.tsx";
import {
	DESK_NEEDS_YOU_VIEW_ID,
	type DeskSort,
	deskDefaultViewId,
	deskRow,
	deskStartInput,
	deskStartLabel,
	deskViewRows,
	findDeskView,
} from "./desk-model.ts";
import { DeskViewSelect, DeskViewsRail } from "./desk-rail.tsx";
import { useAutoOpenFirstThread } from "./interface-auto-open.ts";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";

const MINUTE = 60_000;
/** At or above this width the views rail shows; below it, a select. */
const RAIL_MIN_WIDTH = 1080;
/** At or above this width details sit beside the chat and open by default. */
const DETAILS_INLINE_MIN_WIDTH = 1320;
/** Below this width the list and the conversation take turns. */
const STACKED_MAX_WIDTH = 720;
/** Width assumed before the first measurement (and where layout is absent). */
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** How the empty pane names a scoped view: "Atlas's inbox", "Launch Crew". */
function noSelectionViewLabel(view: DeskView | undefined): string | null {
	if (!view || view.kind === "all" || view.id === DESK_NEEDS_YOU_VIEW_ID) {
		return null;
	}
	return view.kind === "agent" ? `${view.label}'s inbox` : view.label;
}

/** True for targets whose keys belong to typing or to the host's chat. */
function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='desk-thread-view']") !== null
	);
}

/** True when no element holds focus, so page-level keys belong to the desk. */
function isPageTarget(target: EventTarget | null): boolean {
	return (
		target === null ||
		target === document ||
		target === document.body ||
		target === document.documentElement
	);
}

/**
 * Desk interface: a three-pane help-desk inbox. A views rail (shared views,
 * one inbox per agent, teams and projects from `projectDeskViews`), the
 * selected view's conversation list, and the open conversation, which is the
 * host's real chat screen with a collapsible details sidebar beside it. At
 * narrow widths the rail becomes a select, details float over the chat, and
 * below 720px the list and conversation take turns.
 */
export function DeskInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["desk"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const conversationRef = useRef<HTMLElement>(null);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const restoreListFocus = useRef(false);
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();

	const sections = useMemo(() => projectDeskViews(snapshot), [snapshot]);
	const [chosenViewId, setChosenViewId] = useState<string | null>(null);
	const [sort, setSort] = useState<DeskSort>("newest");
	const [cursorId, setCursorId] = useState<string | null>(null);
	// The user moved the cursor (keys or focus), so it is marked on its own.
	const [cursorMoved, setCursorMoved] = useState(false);
	const [detailsPreference, setDetailsPreference] = useState<boolean | null>(
		null
	);
	const [startedWith, setStartedWith] = useState<string | null>(null);

	const railMode = width >= RAIL_MIN_WIDTH;
	const detailsOverlay = width < DETAILS_INLINE_MIN_WIDTH;
	const stacked = width < STACKED_MAX_WIDTH;

	// Lock the opening view once the first real snapshot arrives, so it does
	// not jump to "All conversations" the moment the last reply is read.
	const defaultViewId = deskDefaultViewId(sections, activeThreadId);
	useEffect(() => {
		if (chosenViewId === null && !loading && snapshot.threads.length > 0) {
			setChosenViewId(defaultViewId);
		}
	}, [chosenViewId, defaultViewId, loading, snapshot.threads.length]);
	const viewId =
		chosenViewId && findDeskView(sections, chosenViewId)
			? chosenViewId
			: defaultViewId;
	const view = findDeskView(sections, viewId);
	const rows = useMemo(
		() => deskViewRows(snapshot, view, sort),
		[snapshot, view, sort]
	);
	const order = rows.map((row) => row.thread.id);

	const conversationOpen = threadView !== null && threadView !== undefined;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeRow = activeThread ? deskRow(snapshot, activeThread) : null;
	const detailsOpen =
		conversationOpen &&
		activeRow !== null &&
		(detailsPreference ?? !detailsOverlay);
	const needsYouIds =
		findDeskView(sections, DESK_NEEDS_YOU_VIEW_ID)?.threadIds ?? [];
	// The empty pane points at the list on screen first, then elsewhere.
	const viewNeedsYou = rows.filter((row) => row.needsYou);
	const statusCounts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of snapshot.threads) {
		statusCounts[threadStatus(thread)] += 1;
	}
	const needsYouHint: DeskNeedsYouHint =
		viewNeedsYou.length > 0
			? { count: viewNeedsYou.length, scope: "view" }
			: { count: needsYouIds.length, scope: "elsewhere" };

	// The cursor is the focusable row: the last one the user moved to, else
	// the open thread, else the first row of the view.
	let cursor: string | null = order[0] ?? null;
	if (cursorId && order.includes(cursorId)) {
		cursor = cursorId;
	} else if (activeThreadId && order.includes(activeThreadId)) {
		cursor = activeThreadId;
	}

	useEffect(() => {
		if (activeThreadId) {
			setCursorId(activeThreadId);
			setStartedWith(null);
		}
	}, [activeThreadId]);

	useEffect(() => {
		if (!conversationOpen) {
			setStartedWith(null);
		}
	}, [conversationOpen]);

	// Keep the open thread's row on screen when the host (or a details link)
	// opens a thread below the fold, or the view changes; focus stays put.
	useEffect(() => {
		if (!(activeThreadId && viewId)) {
			return;
		}
		rowElements.current
			.get(activeThreadId)
			?.scrollIntoView?.({ block: "nearest" });
	}, [activeThreadId, viewId]);

	// When the list hides behind an open conversation, move focus into it;
	// when the conversation closes, put focus back on the cursor row.
	useEffect(() => {
		if (conversationOpen) {
			if (stacked) {
				conversationRef.current?.focus({ preventScroll: true });
			}
			return;
		}
		if (restoreListFocus.current && cursor) {
			restoreListFocus.current = false;
			rowElements.current.get(cursor)?.focus({ preventScroll: true });
		}
	}, [conversationOpen, cursor, stacked]);

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

	const moveTo = (threadId: string | undefined) => {
		if (!threadId) {
			return;
		}
		setCursorId(threadId);
		setCursorMoved(true);
		const element = rowElements.current.get(threadId);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView({ block: "nearest" });
	};

	const openThread = (threadId: string) => {
		setCursorId(threadId);
		port.openThread(threadId);
	};

	useAutoOpenFirstThread({
		activeThreadId,
		firstThreadId: order[0] ?? null,
		loading,
		minWidth: STACKED_MAX_WIDTH,
		openThread,
		rootRef,
		threadView,
	});

	const closeThread = () => {
		restoreListFocus.current = true;
		port.closeThread();
	};

	const startThread = () => {
		const named =
			view?.kind === "agent" ||
			view?.kind === "team" ||
			view?.kind === "project";
		setStartedWith(named ? view.label : null);
		port.startThread(deskStartInput(view));
	};

	const selectView = (nextViewId: string) => {
		setChosenViewId(nextViewId);
		setCursorId(null);
		setCursorMoved(false);
	};

	const focusRow = (threadId: string) => {
		setCursorId(threadId);
		setCursorMoved(true);
	};

	/** Team, project and agent links in details switch the list's view. */
	const selectViewFromDetails = (nextViewId: string) => {
		selectView(nextViewId);
		if (stacked) {
			closeThread();
		}
	};

	const toggleDetails = () => setDetailsPreference(!detailsOpen);

	const onKeyDownRow = (
		event: KeyboardEvent<HTMLElement>,
		threadId: string
	) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const index = order.indexOf(threadId);
		const step = deskCursorStep(event.key);
		if (step) {
			event.preventDefault();
			event.stopPropagation();
			const target = {
				first: 0,
				last: order.length - 1,
				next: Math.min(index + 1, order.length - 1),
				previous: Math.max(index - 1, 0),
			}[step];
			moveTo(order[target]);
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			openThread(threadId);
			return;
		}
		if (event.key === "Escape" && conversationOpen) {
			event.preventDefault();
			event.stopPropagation();
			closeThread();
		}
	};

	// Desk-wide single-key shortcuts, kept out of typing and the host's chat.
	const onKeyDownRoot = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			ownsKeys(event.target)
		) {
			return;
		}
		if (event.key === "c") {
			event.preventDefault();
			startThread();
			return;
		}
		if (event.key === "i" && activeRow && conversationOpen) {
			event.preventDefault();
			toggleDetails();
		}
	};

	// The legend's keys also work before anything in the desk has focus:
	// with focus on the page itself, J/K, Enter, C and I act on the list.
	const onPageKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			!isPageTarget(event.target) ||
			isInterfaceCovered(rootRef.current)
		) {
			return;
		}
		const step = deskCursorStep(event.key);
		if (step === "next" || step === "previous") {
			event.preventDefault();
			const index = cursor ? order.indexOf(cursor) : -1;
			// The first press lands on the cursor row itself, which is not
			// marked yet; later presses step from it.
			if (index < 0 || !cursorMoved) {
				moveTo(cursor ?? order[0]);
				return;
			}
			const target =
				step === "next"
					? Math.min(index + 1, order.length - 1)
					: Math.max(index - 1, 0);
			moveTo(order[target]);
			return;
		}
		if (event.key === "Enter" && cursor) {
			event.preventDefault();
			openThread(cursor);
			return;
		}
		if (event.key === "c") {
			event.preventDefault();
			startThread();
			return;
		}
		if (event.key === "i" && activeRow && conversationOpen) {
			event.preventDefault();
			toggleDetails();
		}
	});

	useEffect(() => {
		if (loading) {
			return;
		}
		document.addEventListener("keydown", onPageKeyDown);
		return () => document.removeEventListener("keydown", onPageKeyDown);
	}, [loading]);

	const startLabel = deskStartLabel(view);
	const showList = !(stacked && conversationOpen);
	const showConversation = !stacked || conversationOpen;

	let conversationPane: ReactNode = null;
	if (conversationOpen) {
		conversationPane = (
			<DeskConversation
				details={
					detailsOpen && activeRow ? (
						<DeskDetails
							floating={detailsOverlay}
							now={now}
							onClose={() => setDetailsPreference(false)}
							onOpenThread={openThread}
							onSelectView={selectViewFromDetails}
							row={activeRow}
							snapshot={snapshot}
						/>
					) : null
				}
				detailsOpen={detailsOpen}
				detailsOverlay={detailsOverlay}
				newTargetLabel={startedWith}
				onClose={closeThread}
				onCloseDetails={() => setDetailsPreference(false)}
				onToggleDetails={activeRow ? toggleDetails : null}
				ref={conversationRef}
				row={activeRow}
				stacked={stacked}
				threadView={threadView}
			/>
		);
	} else if (!loading || snapshot.threads.length > 0) {
		conversationPane = (
			<div className="flex min-w-0 flex-1">
				<DeskNoSelection
					empty={snapshot.threads.length === 0}
					needsYou={needsYouHint}
					nextRow={viewNeedsYou[0] ?? null}
					now={now}
					onOpenNext={() => {
						const next = viewNeedsYou[0];
						if (next) {
							openThread(next.thread.id);
						}
					}}
					onShowNeedsYou={() => selectView(DESK_NEEDS_YOU_VIEW_ID)}
					onStart={startThread}
					startLabel={startLabel}
					statusCounts={statusCounts}
					viewLabel={noSelectionViewLabel(view)}
				/>
			</div>
		);
	}

	return (
		<div
			aria-busy={loading}
			className="flex size-full min-h-0 bg-background text-foreground"
			data-layout={stacked ? "stacked" : railMode ? "rail" : "compact"}
			data-testid="interface-desk"
			onKeyDown={onKeyDownRoot}
			ref={rootRef}
		>
			{railMode ? (
				<DeskViewsRail
					loading={loading}
					onSelect={selectView}
					onStart={startThread}
					sections={sections}
					selectedId={viewId}
					snapshot={snapshot}
					startLabel={startLabel}
				/>
			) : null}
			{showList ? (
				<div
					className={cn(
						"flex min-h-0 shrink-0",
						stacked ? "w-full" : "border-border border-r",
						!stacked && (railMode ? "w-[360px]" : "w-[340px]")
					)}
				>
					<DeskConversationList
						activeThreadId={activeThreadId}
						conversationOpen={conversationOpen && activeRow !== null}
						cursorId={cursor}
						cursorMoved={cursorMoved}
						loading={loading}
						now={now}
						onFocusRow={focusRow}
						onKeyDownRow={onKeyDownRow}
						onOpen={openThread}
						onSortChange={setSort}
						onStart={railMode ? null : startThread}
						registerRow={registerRow}
						rows={rows}
						sort={sort}
						stacked={stacked}
						view={view}
						viewSelect={
							railMode ? null : (
								<DeskViewSelect
									className="flex-1"
									onSelect={selectView}
									sections={sections}
									selectedId={viewId}
								/>
							)
						}
					/>
				</div>
			) : null}
			{showConversation ? (
				<div className="flex min-h-0 min-w-0 flex-1">{conversationPane}</div>
			) : null}
		</div>
	);
}
