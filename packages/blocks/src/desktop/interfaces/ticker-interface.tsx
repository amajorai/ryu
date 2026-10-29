import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useNow, useThreadPanelFocus } from "./interface-thread-panel.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { TickerCalendar } from "./ticker-calendar.tsx";
import { TickerDetail } from "./ticker-detail.tsx";
import { TickerHeader } from "./ticker-header.tsx";
import {
	activitySeries,
	buildTickerQuotes,
	DEFAULT_TICKER_RANGE,
	DEFAULT_TICKER_SORT,
	leadThread,
	nextRunFor,
	nextSort,
	sortQuotes,
	type TickerRange,
	type TickerSort,
	type TickerSortKey,
	tapeItems,
	tickerIndex,
	upcomingRuns,
} from "./ticker-model.ts";
import { TickerThreadPanel } from "./ticker-panel.tsx";
import { TickerTape } from "./ticker-tape.tsx";
import { TickerWatchlist } from "./ticker-watchlist.tsx";

/** How often the clock (and "today") refreshes. */
const CLOCK_TICK_MS = 30_000;
/** Below this width the detail stacks under the watchlist. */
const STACKED_QUERY = "(max-width: 767px)";
/** Closing the panel refocuses the thread's row in the detail, else the
 *  selected watchlist row. */
const DETAIL_SCOPE = '[data-testid="ticker-detail"] ';

function DetailSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="flex w-full max-w-[64rem] flex-col gap-6 px-8 py-6 max-sm:px-4"
		>
			<div className="flex items-center gap-4">
				<Skeleton className="size-10" radius="pill" />
				<div className="flex flex-1 flex-col gap-2">
					<Skeleton className="h-6 w-28" radius="dense" />
					<Skeleton className="h-3.5 w-64" radius="dense" />
				</div>
				<Skeleton className="h-9 w-24" radius="pill" />
			</div>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-12 w-32" radius="dense" />
				<Skeleton className="h-4 w-56" radius="dense" />
			</div>
			<Skeleton className="h-40 w-full" radius="panel" />
			<div className="grid grid-cols-4 gap-6">
				<Skeleton className="h-10" radius="dense" />
				<Skeleton className="h-10" radius="dense" />
				<Skeleton className="h-10" radius="dense" />
				<Skeleton className="h-10" radius="dense" />
			</div>
		</div>
	);
}

/**
 * Ticker: agents as a market. A header carries the workspace "index" and
 * breadth, a tape scrolls the newest messages, the watchlist lists every agent
 * as a ticker (symbol, price = messages, change = messages in threads active
 * today, a sparkline over the chart's range), and the detail pane charts the
 * selected agent with its statistics and threads. Opening a thread shows the host's real
 * conversation in a side panel; "Message" starts a new thread with the agent.
 */
export function TickerInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["ticker"]>) {
	const now = useNow(CLOCK_TICK_MS);
	const reduceMotion = useReducedMotion();
	const [sort, setSort] = useState<TickerSort>(DEFAULT_TICKER_SORT);
	const [range, setRange] = useState<TickerRange>(DEFAULT_TICKER_RANGE);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const quotes = useMemo(
		() => buildTickerQuotes(snapshot, now, range),
		[snapshot, now, range]
	);
	const quoteById = useMemo(
		() => new Map(quotes.map((quote) => [quote.agent.id, quote])),
		[quotes]
	);
	const sorted = useMemo(() => sortQuotes(quotes, sort), [quotes, sort]);
	const index = useMemo(
		() => tickerIndex(snapshot, quotes, now),
		[snapshot, quotes, now]
	);
	const symbols = useMemo(
		() => new Map(quotes.map((quote) => [quote.agent.id, quote.symbol])),
		[quotes]
	);
	const tape = useMemo(() => tapeItems(snapshot, symbols), [snapshot, symbols]);
	const runs = useMemo(
		() => upcomingRuns(snapshot, symbols, now),
		[snapshot, symbols, now]
	);

	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;

	// When a thread opens from elsewhere (the tape, the host), follow it to its
	// ticker unless the selected agent is already in it.
	const [followedThreadId, setFollowedThreadId] = useState<string | null>(null);
	if (activeThread && activeThread.id !== followedThreadId) {
		setFollowedThreadId(activeThread.id);
		const firstAgent = activeThread.agentIds.find((id) => quoteById.has(id));
		if (
			firstAgent &&
			!(selectedId && activeThread.agentIds.includes(selectedId))
		) {
			setSelectedId(firstAgent);
		}
	}

	const selected =
		(selectedId ? quoteById.get(selectedId) : undefined) ?? sorted[0];
	const series = useMemo(
		() => activitySeries(selected?.threads ?? [], range, now),
		[selected, range, now]
	);
	const panelOpen = threadView !== null;
	const panelQuote = activeThread
		? (quoteById.get(
				selected && activeThread.agentIds.includes(selected.agent.id)
					? selected.agent.id
					: (activeThread.agentIds[0] ?? "")
			) ?? undefined)
		: selected;

	const {
		closePanel,
		fallbackRef: selectedRowRef,
		headingRef,
		onRootKeyDown,
		openThread,
		rootRef,
		startThread,
	} = useThreadPanelFocus(port, panelOpen, DETAIL_SCOPE);
	const trade = (agentId: string) => {
		setSelectedId(agentId);
		startThread({ agentId });
	};
	const openLead = (agentId: string) => {
		const quote = quoteById.get(agentId);
		const lead = quote ? leadThread(quote) : undefined;
		if (lead) {
			openThread(lead.id);
		}
	};
	const revealRef = useRef(false);
	const pick = (agentId: string, reveal = true) => {
		revealRef.current = reveal && agentId !== selected?.agent.id;
		setSelectedId(agentId);
	};
	const onSort = (key: TickerSortKey) => {
		setSort((current) => nextSort(current, key));
	};

	/*
	 * When the detail is stacked under the list (narrow widths), a tap on a row
	 * would change content far below the fold; bring the detail up to meet it.
	 */
	const selectedAgentId = selected?.agent.id ?? null;
	useEffect(() => {
		if (!(revealRef.current && selectedAgentId)) {
			return;
		}
		revealRef.current = false;
		if (!window.matchMedia(STACKED_QUERY).matches) {
			return;
		}
		rootRef.current
			?.querySelector('[data-testid="ticker-detail"]')
			?.scrollIntoView({
				behavior: reduceMotion ? "auto" : "smooth",
				block: "start",
			});
	}, [selectedAgentId, reduceMotion]);

	const newThread = () => port.startThread({});
	let detail = <DetailSkeleton />;
	if (!(loading || selected)) {
		detail = (
			<Empty className="h-full min-h-80" data-testid="ticker-detail-empty">
				<EmptyHeader>
					<EmptyTitle className="text-base">No agents yet</EmptyTitle>
					<EmptyDescription>
						Each agent gets a row here once it exists.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={newThread} size="sm" type="button" variant="outline">
						<Plus aria-hidden="true" data-icon="inline-start" />
						New thread
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (!loading && selected) {
		detail = (
			<TickerDetail
				activeThreadId={activeThreadId}
				key={selected.agent.id}
				nextRun={nextRunFor(snapshot, selected.agent.id, now)}
				now={now}
				onOpen={openThread}
				onRangeChange={setRange}
				onTrade={trade}
				quote={selected}
				range={range}
				series={series}
			/>
		);
	}

	const panel = panelOpen ? (
		<TickerThreadPanel
			headingRef={headingRef}
			onClose={closePanel}
			quote={panelQuote}
			thread={activeThread}
			threadView={threadView}
		/>
	) : null;

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-ticker"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<TickerHeader
				agentCount={quotes.length}
				index={index}
				loading={loading}
				now={now}
				onNewThread={newThread}
			/>
			<TickerTape
				items={tape}
				loading={loading}
				now={now}
				onOpen={openThread}
				quotes={quoteById}
			/>
			<div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-y-auto md:relative">
				<TickerWatchlist
					loading={loading}
					onNewThread={newThread}
					onOpenLead={openLead}
					onSelect={pick}
					onSort={onSort}
					onTrade={trade}
					quotes={sorted}
					range={range}
					selectedId={selected?.agent.id ?? null}
					selectedRef={selectedRowRef}
					sort={sort}
				>
					{loading ? null : (
						<TickerCalendar
							className="max-md:hidden"
							now={now}
							onSelect={pick}
							runs={runs}
						/>
					)}
				</TickerWatchlist>
				<div className="flex min-h-0 min-w-0 flex-1 max-md:border-border max-md:border-t md:relative">
					<div className="min-w-0 flex-1 md:overflow-y-auto">
						{detail}
						{loading ? null : (
							<TickerCalendar
								className="md:hidden"
								now={now}
								onSelect={pick}
								runs={runs}
							/>
						)}
					</div>
					{panel}
				</div>
			</div>
		</div>
	);
}
