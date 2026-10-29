import { cn } from "@ryu/ui/lib/utils";
import type { InterfacePort } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	ticketsOwnsKeys,
	useTicketsClock,
	useTicketsWidth,
} from "./tickets-hooks.ts";
import {
	buildTickets,
	DEFAULT_TICKET_SORT,
	DEFAULT_TICKET_VIEW,
	EMPTY_TICKET_FILTER,
	findTicketView,
	requesterTickets,
	TICKET_SORT_FIRST_DIRECTION,
	type TicketFilter,
	type TicketGroupBy,
	type TicketSort,
	type TicketSortKey,
	type TicketViewId,
	ticketFilterCount,
	ticketViewCounts,
	ticketViewRows,
} from "./tickets-model.ts";
import { TicketsNewTicket } from "./tickets-new.tsx";
import { TicketsPage, type TicketsPosition } from "./tickets-page.tsx";
import {
	TicketsEmpty,
	TicketsTable,
	type TicketsTableLayout,
} from "./tickets-table.tsx";
import { TicketsTabs } from "./tickets-tabs.tsx";
import {
	TicketsFooter,
	TicketsToolbar,
	TicketsViewHeader,
} from "./tickets-toolbar.tsx";
import { TicketsViewSelect, TicketsViewsPanel } from "./tickets-views.tsx";

/** At or above this width the views panel shows; below it, a select. */
const VIEWS_PANEL_MIN_WIDTH = 1024;
const VIEWS_PANEL_WIDTH = 240;
/** At or above this width the ticket sidebar sits beside the conversation. */
const SIDEBAR_INLINE_MIN_WIDTH = 1180;
/** Below this width the chrome condenses for phones. */
const COMPACT_MAX_WIDTH = 640;
/** Ticket tabs kept open at once, like Zendesk's tab limit. */
const MAX_TABS = 8;

function tableLayoutFor(tableWidth: number): TicketsTableLayout {
	if (tableWidth >= 1100) {
		return "full";
	}
	if (tableWidth >= 960) {
		return "medium";
	}
	if (tableWidth >= COMPACT_MAX_WIDTH) {
		return "narrow";
	}
	return "compact";
}

/**
 * Tickets interface: a Zendesk-style agent workspace. Views with counts on
 * the left, the view's ticket table (status, number, subject, requester,
 * priority, SLA, updated) with bulk selection, filters and grouping, a tab
 * per opened ticket, and a ticket page that shows the host's own
 * conversation between a header and a properties sidebar.
 */
export function TicketsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const descriptionRef = useRef<HTMLTextAreaElement>(null);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const width = useTicketsWidth(rootRef);
	const now = useTicketsClock();

	const [viewId, setViewId] = useState<TicketViewId>(DEFAULT_TICKET_VIEW);
	const [filter, setFilter] = useState<TicketFilter>(EMPTY_TICKET_FILTER);
	const [sort, setSort] = useState<TicketSort>(DEFAULT_TICKET_SORT);
	const [groupBy, setGroupBy] = useState<TicketGroupBy>("status");
	const [cursorId, setCursorId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [tabIds, setTabIds] = useState<string[]>([]);
	const [draftOpen, setDraftOpen] = useState(false);
	const [draftFocused, setDraftFocused] = useState(false);
	const [detailsPreference, setDetailsPreference] = useState<boolean | null>(
		null
	);

	const showViewsPanel = width >= VIEWS_PANEL_MIN_WIDTH;
	const detailsFloating = width < SIDEBAR_INLINE_MIN_WIDTH;
	const compact = width < COMPACT_MAX_WIDTH;
	const tableLayout = tableLayoutFor(
		width - (showViewsPanel ? VIEWS_PANEL_WIDTH : 0)
	);

	const tickets = useMemo(() => buildTickets(snapshot, now), [snapshot, now]);
	const byId = useMemo(
		() => new Map(tickets.map((ticket) => [ticket.id, ticket])),
		[tickets]
	);
	const counts = useMemo(() => ticketViewCounts(tickets, now), [tickets, now]);
	const view = findTicketView(viewId);
	const rows = useMemo(
		() => ticketViewRows(tickets, viewId, filter, sort, groupBy, now),
		[tickets, viewId, filter, sort, groupBy, now]
	);
	const { order } = rows;

	const ticketOpen = threadView !== null && threadView !== undefined;
	const activeTicket = activeThreadId
		? (byId.get(activeThreadId) ?? null)
		: null;
	const screen = (() => {
		if (draftOpen && draftFocused) {
			return "draft";
		}
		return ticketOpen ? "ticket" : "views";
	})();
	const detailsOpen = detailsPreference ?? !detailsFloating;

	let cursor: string | null = order[0] ?? null;
	if (cursorId && order.includes(cursorId)) {
		cursor = cursorId;
	} else if (activeThreadId && order.includes(activeThreadId)) {
		cursor = activeThreadId;
	}

	const tabs = tabIds.flatMap((id) => {
		const ticket = byId.get(id);
		return ticket ? [ticket] : [];
	});

	// Every ticket the host opens gets a tab, newest at the end.
	useEffect(() => {
		if (!(ticketOpen && activeThreadId)) {
			return;
		}
		setCursorId(activeThreadId);
		setDraftFocused(false);
		setTabIds((previous) => {
			if (previous.includes(activeThreadId)) {
				return previous;
			}
			const next = [...previous, activeThreadId];
			return next.length > MAX_TABS ? next.slice(-MAX_TABS) : next;
		});
	}, [activeThreadId, ticketOpen]);

	// Moving between screens unmounts what had focus; put it somewhere useful
	// (the ticket heading, the draft's description, or the cursor row).
	useEffect(() => {
		const active = document.activeElement;
		if (active && active !== document.body) {
			return;
		}
		if (screen === "ticket") {
			headingRef.current?.focus({ preventScroll: true });
		} else if (screen === "draft") {
			descriptionRef.current?.focus({ preventScroll: true });
		}
	}, [screen, activeThreadId]);

	const registerRow = useCallback(
		(ticketId: string, element: HTMLElement | null) => {
			if (element) {
				rowElements.current.set(ticketId, element);
			} else {
				rowElements.current.delete(ticketId);
			}
		},
		[]
	);

	const focusRow = (ticketId: string | null | undefined) => {
		if (!ticketId) {
			return;
		}
		setCursorId(ticketId);
		const element = rowElements.current.get(ticketId);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView?.({ block: "nearest" });
	};

	const openTicket = (ticketId: string) => {
		setCursorId(ticketId);
		setDraftFocused(false);
		port.openThread(ticketId);
	};

	const showViews = () => {
		setDraftFocused(false);
		if (ticketOpen) {
			port.closeThread();
		}
		// Back on the table, the cursor row takes focus once it renders.
		window.requestAnimationFrame(() => {
			const active = document.activeElement;
			if (active === null || active === document.body) {
				focusRow(cursor);
			}
		});
	};

	const closeTab = (ticketId: string) => {
		setTabIds((previous) => previous.filter((id) => id !== ticketId));
		if (ticketId === activeThreadId && screen === "ticket") {
			showViews();
		}
	};

	const newTicket = () => {
		setDraftOpen(true);
		setDraftFocused(true);
		window.requestAnimationFrame(() =>
			descriptionRef.current?.focus({ preventScroll: true })
		);
	};

	const discardDraft = () => {
		setDraftOpen(false);
		setDraftFocused(false);
	};

	const submitTicket = (input: Parameters<InterfacePort["startThread"]>[0]) => {
		setDraftOpen(false);
		setDraftFocused(false);
		port.startThread(input);
	};

	const selectView = (nextViewId: TicketViewId) => {
		setViewId(nextViewId);
		setCursorId(null);
		setSelectedIds(new Set());
	};

	const toggleSort = (key: TicketSortKey) => {
		setSort((previous) =>
			previous.key === key
				? { direction: previous.direction === "asc" ? "desc" : "asc", key }
				: { direction: TICKET_SORT_FIRST_DIRECTION[key], key }
		);
	};

	const toggleSelected = (ticketId: string) => {
		setSelectedIds((previous) => {
			const next = new Set(previous);
			if (next.has(ticketId)) {
				next.delete(ticketId);
			} else {
				next.add(ticketId);
			}
			return next;
		});
	};

	const selectedInView = order.filter((id) => selectedIds.has(id));
	const allSelected =
		order.length > 0 && selectedInView.length === order.length;
	const toggleAll = () => {
		setSelectedIds(allSelected ? new Set() : new Set(order));
	};

	const openSelected = () => {
		const first = selectedInView[0];
		setTabIds((previous) => {
			const next = [...previous];
			for (const id of selectedInView) {
				if (!next.includes(id)) {
					next.push(id);
				}
			}
			return next.slice(-MAX_TABS);
		});
		setSelectedIds(new Set());
		if (first) {
			openTicket(first);
		}
	};

	const index = activeThreadId ? order.indexOf(activeThreadId) : -1;
	const position: TicketsPosition | null =
		index >= 0
			? {
					index,
					nextId: order[index + 1] ?? null,
					previousId: index > 0 ? (order[index - 1] ?? null) : null,
					total: order.length,
				}
			: null;

	// Single-key shortcuts, Zendesk/Gmail style. They run from the workspace
	// (or from nowhere yet, right after switching here), never while typing,
	// inside a menu, inside the host's conversation, or while a page covers
	// the interface.
	const onKey = (event: KeyboardEvent) => {
		const root = rootRef.current;
		const target = event.target;
		if (
			!root ||
			isInterfaceCovered(root) ||
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			ticketsOwnsKeys(target)
		) {
			return;
		}
		const onWorkspace =
			target === document.body ||
			target === document.documentElement ||
			(target instanceof Node && root.contains(target));
		if (!onWorkspace) {
			return;
		}
		const key = event.key;
		if (key === "c" && !event.shiftKey) {
			event.preventDefault();
			newTicket();
			return;
		}
		if (screen === "ticket") {
			if (key === "Escape") {
				event.preventDefault();
				showViews();
			}
			return;
		}
		if (screen === "draft") {
			if (key === "Escape") {
				event.preventDefault();
				discardDraft();
			}
			return;
		}
		const at = cursor ? order.indexOf(cursor) : -1;
		if (key === "j" || key === "ArrowDown") {
			event.preventDefault();
			focusRow(order[Math.min(at + 1, order.length - 1)]);
		} else if (key === "k" || key === "ArrowUp") {
			event.preventDefault();
			focusRow(order[Math.max(at - 1, 0)]);
		} else if ((key === "Enter" || key === "o") && cursor) {
			event.preventDefault();
			openTicket(cursor);
		} else if (key === "x" && cursor) {
			event.preventDefault();
			toggleSelected(cursor);
		} else if (key === "/") {
			event.preventDefault();
			searchRef.current?.focus();
		} else if (key === "Escape" && selectedIds.size > 0) {
			event.preventDefault();
			setSelectedIds(new Set());
		}
	};
	const onKeyRef = useRef(onKey);
	onKeyRef.current = onKey;
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (!isInterfaceCovered(rootRef.current)) {
				onKeyRef.current(event);
			}
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, []);

	const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (filter.query) {
				setFilter({ ...filter, query: "" });
			} else {
				focusRow(cursor);
			}
		} else if (event.key === "ArrowDown" || event.key === "Enter") {
			event.preventDefault();
			focusRow(order[0]);
		}
	};

	const empty = !loading && snapshot.threads.length === 0;
	const filtered = filter.query.trim() !== "" || ticketFilterCount(filter) > 0;
	let body: ReactNode;
	if (empty) {
		body = (
			<TicketsEmpty
				action={{ label: "New ticket", onClick: newTicket }}
				description={
					snapshot.agents.length === 0
						? "Add an agent, then start a conversation with it to open your first ticket."
						: "Every conversation with an agent is a ticket here. Start one to open the first."
				}
				title="No tickets yet"
			/>
		);
	} else if (!loading && rows.total === 0) {
		body = (
			<TicketsEmpty
				action={
					viewId === "all" ? { label: "New ticket", onClick: newTicket } : null
				}
				description={view.empty.description}
				title={view.empty.title}
			/>
		);
	} else if (!loading && order.length === 0 && filtered) {
		body = (
			<TicketsEmpty
				action={null}
				description="No ticket in this view matches the filter."
				title="No matching tickets"
			/>
		);
	} else {
		body = (
			<div className="min-h-0 flex-1 overflow-auto overscroll-contain">
				<TicketsTable
					activeTicketId={activeThreadId}
					allSelected={allSelected}
					cursorId={cursor}
					layout={tableLayout}
					loading={loading && snapshot.threads.length === 0}
					now={now}
					onFocusRow={setCursorId}
					onOpen={openTicket}
					onSort={toggleSort}
					onToggle={toggleSelected}
					onToggleAll={toggleAll}
					registerRow={registerRow}
					sections={rows.sections}
					selectedIds={selectedIds}
					someSelected={selectedInView.length > 0}
					sort={sort}
					viewLabel={view.label}
				/>
			</div>
		);
	}

	const viewsScreen = (
		<div className="flex min-h-0 min-w-0 flex-1">
			{showViewsPanel ? (
				<TicketsViewsPanel
					counts={counts}
					loading={loading && snapshot.threads.length === 0}
					onSelect={selectView}
					selectedId={viewId}
				/>
			) : null}
			<main
				aria-label={view.label}
				className="flex min-h-0 min-w-0 flex-1 flex-col"
				data-testid="tickets-view"
			>
				<TicketsViewHeader
					count={rows.total}
					loading={loading && snapshot.threads.length === 0}
					onPlay={order[0] ? () => openTicket(order[0] as string) : null}
					title={view.label}
					viewSelect={
						showViewsPanel ? null : (
							<TicketsViewSelect
								counts={counts}
								onSelect={selectView}
								selectedId={viewId}
							/>
						)
					}
				/>
				<TicketsToolbar
					agents={snapshot.agents}
					compact={compact}
					filter={filter}
					groupBy={groupBy}
					onClearSelection={() => setSelectedIds(new Set())}
					onFilterChange={(next) => {
						setFilter(next);
						setSelectedIds(new Set());
					}}
					onGroupByChange={setGroupBy}
					onOpenSelected={openSelected}
					onSearchKeyDown={onSearchKeyDown}
					searchRef={searchRef}
					selectedCount={selectedInView.length}
				/>
				{body}
				{empty ? null : (
					<TicketsFooter
						showHints={!compact}
						shown={order.length}
						total={rows.total}
					/>
				)}
			</main>
		</div>
	);

	return (
		<div
			aria-busy={loading}
			className="flex size-full min-h-0 flex-col bg-background text-foreground"
			data-screen={screen}
			data-testid="interface-tickets"
			ref={rootRef}
		>
			<TicketsTabs
				activeId={screen === "ticket" ? activeThreadId : null}
				compact={compact}
				composing={draftOpen}
				draftCurrent={screen === "draft"}
				onCloseDraft={discardDraft}
				onCloseTab={closeTab}
				onNewTicket={newTicket}
				onOpenTab={openTicket}
				onShowDraft={() => setDraftFocused(true)}
				onShowViews={showViews}
				tabs={tabs}
				viewsCurrent={screen === "views"}
			/>
			<div className="relative flex min-h-0 flex-1">
				{screen === "views" ? viewsScreen : null}
				{ticketOpen ? (
					<div
						className={cn(
							"flex min-h-0 min-w-0 flex-1",
							screen !== "ticket" && "hidden"
						)}
					>
						<TicketsPage
							detailsFloating={detailsFloating}
							detailsOpen={detailsOpen}
							headingRef={headingRef}
							now={now}
							onClose={showViews}
							onCloseDetails={() => setDetailsPreference(false)}
							onOpenTicket={openTicket}
							onToggleDetails={() => setDetailsPreference(!detailsOpen)}
							others={
								activeTicket ? requesterTickets(tickets, activeTicket) : []
							}
							position={position}
							threadView={threadView}
							ticket={activeTicket}
						/>
					</div>
				) : null}
				{draftOpen ? (
					<div
						className={cn(
							"flex min-h-0 min-w-0 flex-1",
							screen !== "draft" && "hidden"
						)}
					>
						<TicketsNewTicket
							agents={snapshot.agents}
							defaultAgentId={
								filter.requesterIds.find((id) =>
									snapshot.agents.some((agent) => agent.id === id)
								) ?? snapshot.agents[0]?.id
							}
							descriptionRef={descriptionRef}
							groups={snapshot.groups}
							onCancel={discardDraft}
							onSubmit={submitTicket}
							stacked={detailsFloating}
						/>
					</div>
				) : null}
			</div>
		</div>
	);
}
