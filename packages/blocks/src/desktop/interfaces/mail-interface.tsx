import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceParamsByRenderer,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAutoOpenFirstThread } from "./interface-auto-open.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { MailCompose } from "./mail-compose.tsx";
import { MailHeader } from "./mail-header.tsx";
import {
	LINE_MIN_LIST_WIDTH,
	NAV_HIDDEN_BELOW,
	NAV_RAIL_BELOW,
	PREVIEW_MIN_WIDTH,
	SPLIT_MIN_WIDTH,
	useElementWidth,
	useMinuteClock,
} from "./mail-interface-hooks.ts";
import { MailComposeFab, MailNavOverlay } from "./mail-interface-overlays.tsx";
import { mailReaderModelFor } from "./mail-interface-reader-model.ts";
import { useMailShortcuts } from "./mail-interface-shortcuts.ts";
import { MailEmptyAction, MailList } from "./mail-list.tsx";
import {
	findMailFolder,
	MAIL_INBOX_VIEW,
	MAIL_PAGE_SIZE,
	type MailStartInput,
	type MailView,
	mailFolderCounts,
	mailIsUnread,
	mailLabels,
	mailLabelUnread,
	mailListDate,
	mailPageCount,
	mailSenders,
	mailSnippet,
	mailStatusChip,
	mailSubject,
	mailThreadLabels,
	mailViewLabel,
	mailViewThreads,
} from "./mail-model.ts";
import { MailNav } from "./mail-nav.tsx";
import { MailPreview, MailReader } from "./mail-reader.tsx";
import type { MailRowModel } from "./mail-row.tsx";

/**
 * Mail: Gmail's web client over the user's agents. Folders are thread states
 * (Inbox is everything waiting on the user), labels are teams and projects,
 * the message list is Gmail's, and the reading pane shows the host's own
 * conversation surface beside the list (split view) or in its place when the
 * window is narrow. Compose opens Gmail's docked window and starts a thread
 * with the typed subject and body. Gmail's keys work: j/k, o or Enter, u, x,
 * c, and / for search.
 */
export function MailInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["mail"]>) {
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const readerRef = useRef<HTMLElement>(null);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const restoreListFocus = useRef(false);
	const width = useElementWidth(rootRef);
	const [now, refreshClock] = useMinuteClock();

	const [view, setView] = useState<MailView>(MAIL_INBOX_VIEW);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const [cursorId, setCursorId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [composeKey, setComposeKey] = useState<number | null>(null);
	const [navPreference, setNavPreference] = useState<boolean | null>(null);
	const [navOverlayOpen, setNavOverlayOpen] = useState(false);

	const navHidden = width < NAV_HIDDEN_BELOW;
	const navExpanded = navPreference ?? width >= NAV_RAIL_BELOW;
	const conversationOpen = threadView !== null && threadView !== undefined;
	const split = width >= SPLIT_MIN_WIDTH;
	const showList = !conversationOpen || split;

	// Validate the view against the current groups: a deleted label falls
	// back to the inbox instead of an empty, unnamed list.
	const currentView =
		view.kind === "label" &&
		!snapshot.groups.some((group) => group.id === view.id)
			? MAIL_INBOX_VIEW
			: view;
	const folderId = currentView.kind === "folder" ? currentView.id : null;
	const viewLabel = mailViewLabel(snapshot, currentView);
	const searching = query.trim().length > 0;

	const threads = useMemo(
		() => mailViewThreads(snapshot, currentView, query),
		[snapshot, currentView, query]
	);
	const pageCount = mailPageCount(threads.length);
	const currentPage = Math.min(page, pageCount - 1);
	const counts = useMemo(() => mailFolderCounts(snapshot), [snapshot]);
	const labelUnread = useMemo(() => mailLabelUnread(snapshot), [snapshot]);
	const labels = useMemo(() => mailLabels(snapshot), [snapshot]);

	const rows: MailRowModel[] = threads
		.slice(currentPage * MAIL_PAGE_SIZE, (currentPage + 1) * MAIL_PAGE_SIZE)
		.map((thread) => ({
			date: mailListDate(thread.updatedAt, now),
			labels: mailThreadLabels(snapshot, thread).filter(
				(group) =>
					!(currentView.kind === "label" && group.id === currentView.id)
			),
			senders: mailSenders(snapshot, thread, folderId),
			snippet: mailSnippet(thread),
			status: mailStatusChip(thread),
			subject: mailSubject(thread),
			thread,
			unread: mailIsUnread(thread),
		}));
	const order = rows.map((row) => row.thread.id);

	let cursor: string | null = order[0] ?? null;
	if (cursorId && order.includes(cursorId)) {
		cursor = cursorId;
	} else if (activeThreadId && order.includes(activeThreadId)) {
		cursor = activeThreadId;
	}

	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeIndex = activeThread
		? threads.findIndex((thread) => thread.id === activeThread.id)
		: -1;
	const readerModelFor = (thread: InterfaceThread) =>
		mailReaderModelFor(snapshot, threads, thread, now);
	const readerModel = activeThread ? readerModelFor(activeThread) : null;
	// On a wide window the reading pane never sits empty: at rest it previews
	// the cursor row, the way a desktop mail client's reading pane does.
	const cursorThread =
		cursor === null ? undefined : rows.find((row) => row.thread.id === cursor);
	const previewModel =
		!conversationOpen && width >= PREVIEW_MIN_WIDTH && cursorThread
			? readerModelFor(cursorThread.thread)
			: null;
	const paneOpen = conversationOpen || previewModel !== null;

	useEffect(() => {
		if (activeThreadId) {
			setCursorId(activeThreadId);
		}
	}, [activeThreadId]);

	// When the reading pane replaces the list, move focus into it; when it
	// closes, put focus back on the row the user came from.
	useEffect(() => {
		if (conversationOpen) {
			if (!split) {
				readerRef.current?.focus({ preventScroll: true });
			}
			return;
		}
		if (restoreListFocus.current && cursor) {
			restoreListFocus.current = false;
			rowElements.current.get(cursor)?.focus({ preventScroll: true });
		}
	}, [conversationOpen, cursor, split]);

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

	const moveCursorTo = (threadId: string | undefined) => {
		if (!threadId) {
			return;
		}
		setCursorId(threadId);
		const element = rowElements.current.get(threadId);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView?.({ block: "nearest" });
	};

	const openThread = (threadId: string) => {
		setCursorId(threadId);
		port.openThread(threadId);
	};

	useAutoOpenFirstThread({
		activeThreadId,
		firstThreadId: order[0] ?? null,
		loading,
		minWidth: SPLIT_MIN_WIDTH,
		openThread,
		rootRef,
		threadView,
	});

	const closeThread = () => {
		restoreListFocus.current = true;
		port.closeThread();
	};

	const selectView = (next: MailView) => {
		setView(next);
		setQuery("");
		setPage(0);
		setCursorId(null);
		setSelectedIds(new Set());
		setNavOverlayOpen(false);
		if (conversationOpen && !split) {
			closeThread();
		}
	};

	// A second "c" keeps the open draft rather than discarding it.
	const openCompose = () => setComposeKey((key) => key ?? Date.now());

	const sendCompose = (input: MailStartInput) => {
		setComposeKey(null);
		port.startThread(input);
	};

	const toggleSelected = (threadId: string) => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(threadId)) {
				next.delete(threadId);
			} else {
				next.add(threadId);
			}
			return next;
		});
	};

	const toggleAll = () => {
		setSelectedIds((current) => {
			const allOnPage =
				order.length > 0 && order.every((id) => current.has(id));
			return allOnPage ? new Set() : new Set(order);
		});
	};

	const refresh = () => {
		refreshClock();
		setSelectedIds(new Set());
	};

	const toggleNav = () => {
		if (navHidden) {
			setNavOverlayOpen((open) => !open);
			return;
		}
		setNavPreference(!navExpanded);
	};

	const stepConversation = (step: "next" | "previous") => {
		const target = threads[activeIndex + (step === "next" ? 1 : -1)];
		if (activeIndex !== -1 && target) {
			openThread(target.id);
		}
	};

	const stepCursor = (step: "next" | "previous") => {
		const index = cursor ? order.indexOf(cursor) : -1;
		const target =
			step === "next"
				? Math.min(index + 1, order.length - 1)
				: Math.max(index - 1, 0);
		moveCursorTo(order[target]);
	};

	const onKeyDownRow = useMailShortcuts({
		activeIndex,
		closeThread,
		conversationOpen,
		cursor,
		moveCursorTo,
		openCompose,
		openThread,
		order,
		rootRef,
		searchRef,
		showList,
		stepConversation,
		stepCursor,
		toggleSelected,
	});

	const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setQuery("");
			event.currentTarget.blur();
			return;
		}
		if (event.key === "Enter" || event.key === "ArrowDown") {
			event.preventDefault();
			moveCursorTo(order[0]);
		}
	};

	let emptyMessage = "No conversations yet.";
	let emptyAction: ReactNode = (
		<MailEmptyAction label="Compose" onClick={openCompose} />
	);
	if (searching) {
		emptyMessage = "No conversations matched your search.";
		emptyAction = (
			<MailEmptyAction label="Clear search" onClick={() => setQuery("")} />
		);
	} else if (snapshot.threads.length > 0) {
		emptyMessage =
			currentView.kind === "folder"
				? findMailFolder(currentView.id).empty
				: tl("No conversations labeled {viewLabel}.", { viewLabel });
		emptyAction = (
			<MailEmptyAction
				label="Show all mail"
				onClick={() => selectView({ id: "all", kind: "folder" })}
			/>
		);
	}

	const listWidth = split && paneOpen ? width * 0.4 : width;
	const density =
		listWidth - (navHidden ? 0 : navExpanded ? 256 : 72) >= LINE_MIN_LIST_WIDTH
			? "line"
			: "stack";
	const composeLabel =
		currentView.kind === "label"
			? (snapshot.groups.find((group) => group.id === currentView.id) ?? null)
			: null;

	const nav = (collapsed: boolean) => (
		<MailNav
			collapsed={collapsed}
			composeDisabled={loading && snapshot.agents.length === 0}
			counts={counts}
			labels={labels}
			labelUnread={labelUnread}
			loading={loading && snapshot.threads.length === 0}
			onCompose={() => {
				setNavOverlayOpen(false);
				openCompose();
			}}
			onSelect={selectView}
			view={searching ? null : currentView}
		/>
	);

	return (
		<div
			aria-busy={loading}
			className="relative flex size-full min-h-0 flex-col overflow-hidden bg-sidebar text-foreground"
			data-layout={split ? "split" : "single"}
			data-testid="interface-mail"
			ref={rootRef}
		>
			<MailHeader
				compact={navHidden}
				navOpen={navHidden ? navOverlayOpen : navExpanded}
				onQueryChange={(next) => {
					setQuery(next);
					setPage(0);
				}}
				onSearchKeyDown={onSearchKeyDown}
				onToggleNav={toggleNav}
				query={query}
				searchRef={searchRef}
			/>
			<div className="relative flex min-h-0 flex-1">
				{navHidden ? null : nav(!navExpanded)}
				<main
					aria-label={searching ? "Search results" : viewLabel}
					className={cn(
						"flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-background",
						navHidden ? "mx-2 mb-2" : "mr-4 mb-4"
					)}
				>
					{showList ? (
						<div
							className={cn(
								"flex min-h-0 min-w-0",
								paneOpen
									? "w-[40%] min-w-[340px] max-w-[520px] shrink-0 border-border border-r"
									: "flex-1"
							)}
						>
							<MailList
								activeThreadId={
									conversationOpen
										? activeThreadId
										: (previewModel?.thread.id ?? null)
								}
								cursorId={cursor}
								cursorMarked={cursorId !== null && cursor === cursorId}
								density={paneOpen ? "stack" : density}
								emptyAction={emptyAction}
								emptyMessage={emptyMessage}
								listLabel={searching ? "Search results" : viewLabel}
								loading={loading}
								onFocusRow={setCursorId}
								onKeyDownRow={onKeyDownRow}
								onNextPage={() => setPage(currentPage + 1)}
								onOpen={openThread}
								onPreviousPage={() => setPage(Math.max(0, currentPage - 1))}
								onRefresh={refresh}
								onToggleAll={toggleAll}
								onToggleSelected={toggleSelected}
								page={currentPage}
								pageCount={pageCount}
								registerRow={registerRow}
								rows={rows}
								selectedIds={selectedIds}
								total={threads.length}
							/>
						</div>
					) : null}
					{conversationOpen ? (
						<MailReader
							backLabel={tl("Back to {view}", {
								view: searching ? "Search results" : viewLabel,
							})}
							model={readerModel}
							onBack={closeThread}
							onNewer={
								activeIndex > 0 ? () => stepConversation("previous") : null
							}
							onOlder={
								activeIndex !== -1 && activeIndex < threads.length - 1
									? () => stepConversation("next")
									: null
							}
							ref={readerRef}
							threadView={threadView}
						/>
					) : null}
					{previewModel ? (
						<MailPreview
							model={previewModel}
							onOpen={() => openThread(previewModel.thread.id)}
						/>
					) : null}
				</main>
				{navHidden && navOverlayOpen ? (
					<MailNavOverlay onClose={() => setNavOverlayOpen(false)}>
						{nav(false)}
					</MailNavOverlay>
				) : null}
			</div>
			{navHidden && composeKey === null && !navOverlayOpen ? (
				<MailComposeFab onClick={openCompose} />
			) : null}
			{composeKey === null ? null : (
				<MailCompose
					defaultAgentId={
						snapshot.agents.length === 1
							? (snapshot.agents[0]?.id ?? null)
							: null
					}
					key={composeKey}
					label={composeLabel}
					onClose={() => setComposeKey(null)}
					onSend={sendCompose}
					snapshot={snapshot}
				/>
			)}
		</div>
	);
}
