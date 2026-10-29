import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { RecordsBoard } from "./records-board.tsx";
import {
	findRecordsView,
	RECORDS_DEFAULT_SORT,
	RECORDS_EMPTY_FILTER,
	RECORDS_OBJECT_LABELS,
	RECORDS_VIEWS,
	type RecordsFilter,
	type RecordsObject,
	type RecordsSort,
	recordsBoard,
	recordsFilterCount,
	recordsFiltered,
	recordsNextSort,
	recordsObjectCounts,
	recordsRows,
	recordsSorted,
	recordsStartInput,
	recordsViewRows,
} from "./records-model.ts";
import { RECORDS_OBJECT_ICONS, RecordsNav } from "./records-nav.tsx";
import { RecordsPage, type RecordsRelatedTarget } from "./records-page.tsx";
import { RecordsThreadPanel } from "./records-parts.tsx";
import { RecordsTable } from "./records-table.tsx";
import {
	RecordsHeader,
	type RecordsLayout,
	RecordsToolbar,
} from "./records-toolbar.tsx";

const MINUTE = 60_000;
/** At or above this width the objects rail shows; below it, a menu. */
const NAV_MIN_WIDTH = 768;
/** At or above this width an open thread docks; below it, it floats. */
const DOCK_MIN_WIDTH = 1100;
/** Content width below which a record's attributes move into the page. */
const DETAILS_ASIDE_MIN_WIDTH = 760;
/** Main-column width at which inline attributes split into two columns. */
const DETAILS_TWO_COLUMN_MIN_WIDTH = 720;
/** Width of the objects rail (w-56). */
const NAV_WIDTH = 224;
/** The docked thread panel's width: clamp(380px, 40%, 560px). */
const DOCK_MIN = 380;
const DOCK_MAX = 560;
const DOCK_SHARE = 0.4;
/** Width assumed before the first measurement. */
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
		target.closest("[data-testid='records-thread-panel']") !== null
	);
}

function cursorStep(
	key: string
): "first" | "last" | "next" | "previous" | null {
	switch (key) {
		case "ArrowDown":
		case "j":
			return "next";
		case "ArrowUp":
		case "k":
			return "previous";
		case "Home":
			return "first";
		case "End":
			return "last";
		default:
			return null;
	}
}

interface OpenRecord {
	id: string;
	object: RecordsObject;
}

/**
 * Records interface, after Attio and Folk: agents, teams, and projects as CRM
 * records. A rail of objects and saved views; an object table (or a board by
 * status) with sort, filter, and search; and a record page with quick actions,
 * an activity timeline of the record's threads, and its attributes. An open
 * thread is the host's real chat, docked beside whatever is on screen.
 */
export function RecordsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["records"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const rowElements = useRef(new Map<string, HTMLElement>());
	const focusRowOnReturn = useRef<string | null>(null);
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();

	const [object, setObject] = useState<RecordsObject>("agents");
	const [activeViewId, setActiveViewId] = useState<string | null>(null);
	const [layout, setLayout] = useState<RecordsLayout>("table");
	const [sort, setSort] = useState<RecordsSort>(RECORDS_DEFAULT_SORT);
	const [filter, setFilter] = useState<RecordsFilter>(RECORDS_EMPTY_FILTER);
	const [query, setQuery] = useState("");
	const [openRecord, setOpenRecord] = useState<OpenRecord | null>(null);
	const [cursorId, setCursorId] = useState<string | null>(null);

	const showNav = width >= NAV_MIN_WIDTH;
	const dockThread = width >= DOCK_MIN_WIDTH;
	const contentWidth = width - (showNav ? NAV_WIDTH : 0);
	const conversationOpen = threadView !== null && threadView !== undefined;
	const pageWidth =
		conversationOpen && dockThread
			? contentWidth -
				Math.min(DOCK_MAX, Math.max(DOCK_MIN, contentWidth * DOCK_SHARE))
			: contentWidth;

	const allRows = useMemo(
		() => recordsRows(snapshot, object),
		[snapshot, object]
	);
	const rows = useMemo(
		() => recordsSorted(recordsFiltered(allRows, filter, query, now), sort),
		[allRows, filter, query, now, sort]
	);
	const order = useMemo(
		() =>
			layout === "board"
				? recordsBoard(rows).flatMap((column) =>
						column.rows.map((row) => row.id)
					)
				: rows.map((row) => row.id),
		[layout, rows]
	);
	const counts = useMemo(() => recordsObjectCounts(snapshot), [snapshot]);
	const viewCounts = useMemo(() => {
		const result: Record<string, number> = {};
		for (const view of RECORDS_VIEWS) {
			result[view.id] = recordsViewRows(snapshot, view, now).length;
		}
		return result;
	}, [snapshot, now]);
	const view = findRecordsView(activeViewId);

	const openRows = useMemo(
		() =>
			openRecord && openRecord.object !== object
				? recordsRows(snapshot, openRecord.object)
				: allRows,
		[allRows, object, openRecord, snapshot]
	);
	const openRow = openRecord
		? openRows.find((row) => row.id === openRecord.id)
		: undefined;
	const openIndex = openRow ? order.indexOf(openRow.id) : -1;

	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;

	const cursor =
		cursorId && order.includes(cursorId) ? cursorId : (order[0] ?? null);

	// A record that disappears from the snapshot closes its page.
	useEffect(() => {
		if (openRecord && !loading && !openRow) {
			setOpenRecord(null);
		}
	}, [loading, openRecord, openRow]);

	// A thread the host opens from elsewhere (a deep link, a notification)
	// lands on its agent's record page, so the chat has its context beside it.
	// Each thread is revealed once; going back to the table keeps the chat
	// docked there.
	const revealedThread = useRef<string | null>(null);
	useEffect(() => {
		if (
			loading ||
			!conversationOpen ||
			!activeThreadId ||
			revealedThread.current === activeThreadId
		) {
			return;
		}
		revealedThread.current = activeThreadId;
		if (openRecord) {
			return;
		}
		const agentId = snapshot.threads.find(
			(thread) => thread.id === activeThreadId
		)?.agentIds[0];
		if (agentId && snapshot.agents.some((agent) => agent.id === agentId)) {
			setOpenRecord({ id: agentId, object: "agents" });
		}
	}, [activeThreadId, conversationOpen, loading, openRecord, snapshot]);

	// Moving between pages keeps focus somewhere sensible: the record's name
	// on the way in, the row it came from on the way back.
	useEffect(() => {
		if (openRow) {
			// Never pull focus out of the host's chat (its composer may be busy).
			const typingInChat =
				document.activeElement?.closest(
					"[data-testid='records-thread-panel']"
				) != null;
			if (!typingInChat) {
				headingRef.current?.focus({ preventScroll: true });
			}
			return;
		}
		const returnTo = focusRowOnReturn.current;
		if (returnTo) {
			focusRowOnReturn.current = null;
			rowElements.current.get(returnTo)?.focus({ preventScroll: true });
		}
	}, [openRow]);

	const registerRow = useCallback((id: string, element: HTMLElement | null) => {
		if (element) {
			rowElements.current.set(id, element);
		} else {
			rowElements.current.delete(id);
		}
	}, []);

	const resetTo = (nextObject: RecordsObject) => {
		setObject(nextObject);
		setActiveViewId(null);
		setFilter(RECORDS_EMPTY_FILTER);
		setSort(RECORDS_DEFAULT_SORT);
		setQuery("");
		setCursorId(null);
		setOpenRecord(null);
	};

	const selectView = (viewId: string) => {
		const next = findRecordsView(viewId);
		if (!next) {
			return;
		}
		setObject(next.object);
		setActiveViewId(next.id);
		setFilter(next.filter);
		setSort(next.sort);
		setQuery("");
		setCursorId(null);
		setOpenRecord(null);
	};

	const changeFilter = (next: RecordsFilter) => {
		setFilter(next);
		setActiveViewId(null);
	};

	const changeSort = (next: RecordsSort) => {
		setSort(next);
		setActiveViewId(null);
	};

	const openRecordPage = (id: string) => {
		setCursorId(id);
		setOpenRecord({ id, object });
	};

	const openRelated = (target: RecordsRelatedTarget) => {
		if (target.object !== object) {
			resetTo(target.object);
		}
		setCursorId(target.id);
		setOpenRecord(target);
	};

	const backToTable = () => {
		focusRowOnReturn.current = openRecord?.id ?? null;
		setOpenRecord(null);
	};

	const stepRecord = (delta: -1 | 1) => {
		const id = order[openIndex + delta];
		if (openIndex !== -1 && id) {
			openRecordPage(id);
		}
	};

	const moveTo = (id: string | undefined) => {
		if (!id) {
			return;
		}
		setCursorId(id);
		const element = rowElements.current.get(id);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView?.({ block: "nearest" });
	};

	const onKeyDownRow = (event: KeyboardEvent<HTMLElement>, id: string) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const step = cursorStep(event.key);
		if (!step) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const index = order.indexOf(id);
		const target = {
			first: 0,
			last: order.length - 1,
			next: Math.min(index + 1, order.length - 1),
			previous: Math.max(index - 1, 0),
		}[step];
		moveTo(order[target]);
	};

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
		if (event.key === "/") {
			event.preventDefault();
			if (openRow) {
				backToTable();
			}
			window.requestAnimationFrame(() => searchRef.current?.focus());
			return;
		}
		if (!openRow) {
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			if (conversationOpen) {
				port.closeThread();
			} else {
				backToTable();
			}
			return;
		}
		if (event.key === "j" || event.key === "k") {
			event.preventDefault();
			stepRecord(event.key === "j" ? 1 : -1);
		}
	};

	const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (query) {
				setQuery("");
			} else {
				event.currentTarget.blur();
			}
			return;
		}
		if (event.key === "ArrowDown" || event.key === "Enter") {
			event.preventDefault();
			moveTo(order[0]);
		}
	};

	const clearFilters = () => {
		setFilter(RECORDS_EMPTY_FILTER);
		setQuery("");
		setActiveViewId(null);
	};

	const threadPanel = conversationOpen ? (
		<RecordsThreadPanel
			floating={!dockThread}
			onClose={port.closeThread}
			snapshot={snapshot}
			thread={activeThread}
			threadView={threadView}
		/>
	) : null;

	const labels = RECORDS_OBJECT_LABELS[object];
	let collection: ReactNode;
	if (!loading && allRows.length === 0) {
		const Icon = RECORDS_OBJECT_ICONS[object];
		collection = (
			<Empty className="h-full" data-testid="records-empty">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Icon aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle className="text-sm">
						No {labels.plural.toLowerCase()} yet
					</EmptyTitle>
					<EmptyDescription className="text-[13px]">
						{object === "agents"
							? "Agents you create in Ryu appear here as records, with their threads and status."
							: `${labels.plural} you create in Ryu appear here, with their members and threads.`}
					</EmptyDescription>
				</EmptyHeader>
				{object === "agents" ? null : (
					<EmptyContent>
						<Button
							onClick={() => resetTo("agents")}
							size="sm"
							type="button"
							variant="outline"
						>
							Show agents
						</Button>
					</EmptyContent>
				)}
			</Empty>
		);
	} else if (!loading && rows.length === 0) {
		collection = (
			<Empty className="h-full" data-testid="records-no-match">
				<EmptyHeader>
					<EmptyTitle className="text-sm">
						No {labels.plural.toLowerCase()} match
					</EmptyTitle>
					<EmptyDescription className="text-[13px]">
						{query
							? `Nothing matches “${query.trim()}” with the current filters.`
							: "No records meet every filter in this view."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={clearFilters}
						size="sm"
						type="button"
						variant="outline"
					>
						{recordsFilterCount(filter) > 0 || query
							? "Clear filters"
							: "Show all"}
					</Button>
				</EmptyContent>
			</Empty>
		);
	} else if (layout === "board" && !loading) {
		collection = (
			<RecordsBoard
				cursorId={cursor}
				now={now}
				onFocusRow={setCursorId}
				onKeyDownRow={onKeyDownRow}
				onOpen={openRecordPage}
				registerRow={registerRow}
				rows={rows}
			/>
		);
	} else {
		collection = (
			<RecordsTable
				cursorId={cursor}
				loading={loading}
				now={now}
				object={object}
				onFocusRow={setCursorId}
				onKeyDownRow={onKeyDownRow}
				onOpen={openRecordPage}
				onSort={(key) => changeSort(recordsNextSort(sort, key))}
				registerRow={registerRow}
				rows={rows}
				sort={sort}
			/>
		);
	}

	const docked = dockThread ? threadPanel : null;
	const floating = dockThread ? null : threadPanel;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: page-wide shortcuts bubble here from focused controls.
		<div
			aria-busy={loading}
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-layout={showNav ? "rail" : "compact"}
			data-testid="interface-records"
			onKeyDown={onKeyDownRoot}
			ref={rootRef}
		>
			{showNav ? (
				<RecordsNav
					activeViewId={activeViewId}
					counts={counts}
					loading={loading}
					object={object}
					onSelectObject={resetTo}
					onSelectView={selectView}
					viewCounts={viewCounts}
				/>
			) : null}
			{openRow ? (
				<RecordsPage
					activeThreadId={conversationOpen ? activeThreadId : null}
					detailsColumns={pageWidth >= DETAILS_TWO_COLUMN_MIN_WIDTH ? 2 : 1}
					detailsInline={contentWidth < DETAILS_ASIDE_MIN_WIDTH}
					headingRef={headingRef}
					now={now}
					onBack={backToTable}
					onMessage={() => port.startThread(recordsStartInput(openRow))}
					onNext={
						openIndex !== -1 && openIndex < order.length - 1
							? () => stepRecord(1)
							: null
					}
					onOpenRecord={openRelated}
					onOpenThread={port.openThread}
					onPrevious={openIndex > 0 ? () => stepRecord(-1) : null}
					position={
						openIndex === -1 ? null : { index: openIndex, total: order.length }
					}
					row={openRow}
					side={docked}
					snapshot={snapshot}
				/>
			) : (
				<>
					<main
						aria-label={labels.plural}
						className="flex min-h-0 min-w-0 flex-1 flex-col"
					>
						<RecordsHeader
							compact={!showNav}
							count={rows.length}
							loading={loading}
							object={object}
							onSelectObject={resetTo}
							onSelectView={selectView}
							onStart={() => port.startThread({})}
							view={view}
						/>
						<RecordsToolbar
							filter={filter}
							layout={layout}
							onFilterChange={changeFilter}
							onLayoutChange={setLayout}
							onQueryChange={setQuery}
							onSearchKeyDown={onSearchKeyDown}
							onSortChange={changeSort}
							query={query}
							searchLabel={`Search ${labels.plural.toLowerCase()}`}
							searchRef={searchRef}
							sort={sort}
						/>
						<div className="min-h-0 flex-1 overflow-auto">{collection}</div>
					</main>
					{docked}
				</>
			)}
			{floating}
		</div>
	);
}
