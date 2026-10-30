import {
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	activitySeries,
	dailyActivity,
	directionOf,
} from "./ticker-model-series.ts";
import { FALLBACK_SYMBOL, tickerSymbols } from "./ticker-model-symbols.ts";
import {
	SPARK_DAYS,
	type TickerDay,
	type TickerDirection,
	type TickerIndex,
	type TickerQuote,
	type TickerSort,
	type TickerSortKey,
	type TickerStats,
	type TickerTapeItem,
} from "./ticker-model-types.ts";

/**
 * Ticker view model. Every agent is a listed "ticker": a short symbol, a
 * "price" (messages across its threads), a day change in the same unit (the
 * price now minus the previous close) and a daily series of closes. Pure
 * functions, so the numbers are testable without a DOM and the same for every
 * render.
 *
 * Threads carry only their newest activity time and a total message count, so
 * a thread's messages all land on the day it was last active. The day change
 * is therefore the messages in threads active today (not only the ones sent
 * today), it is never negative, and the copy says so instead of calling it
 * "added today".
 */

export {
	describeChange,
	formatChange,
	formatClock,
	formatDay,
	formatPercent,
	formatPrice,
	formatShortDay,
	formatWeekdayClock,
	plural,
	spokenAge,
} from "./ticker-model-format.ts";
export {
	activitySeries,
	dailyActivity,
	openingPrice,
	seriesDirection,
	seriesPeriod,
	type TickerSeries,
} from "./ticker-model-series.ts";
export { symbolCandidates, tickerSymbols } from "./ticker-model-symbols.ts";
export {
	DEFAULT_TICKER_RANGE,
	DEFAULT_TICKER_SORT,
	SPARK_DAYS,
	TICKER_RANGE_LABELS,
	TICKER_RANGE_NAMES,
	TICKER_RANGE_PERIODS,
	TICKER_RANGES,
	type TickerDay,
	type TickerDirection,
	type TickerIndex,
	type TickerQuote,
	type TickerRange,
	type TickerSort,
	type TickerSortDirection,
	type TickerSortKey,
	type TickerStats,
	type TickerTapeItem,
} from "./ticker-model-types.ts";

const TAPE_LIMIT = 16;

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Below this previous close, a percent move is noise ("+640%" on 5 messages). */
const PERCENT_FLOOR = 10;
/** A percent is shown only when the base is at least this share of the price. */
const PERCENT_BASE_RATIO = 0.25;

/**
 * The percent worth printing next to a move, or null when the base it is
 * measured against is too small for the figure to mean anything.
 */
export function shownPercent(
	changePercent: number | null,
	previousClose: number,
	price: number
): number | null {
	if (
		changePercent === null ||
		previousClose < PERCENT_FLOOR ||
		previousClose < price * PERCENT_BASE_RATIO
	) {
		return null;
	}
	return changePercent;
}

function percentChange(change: number, previousClose: number): number | null {
	if (previousClose === 0) {
		return change === 0 ? 0 : null;
	}
	return (change / previousClose) * 100;
}

interface DayMove {
	change: number;
	changePercent: number | null;
	direction: TickerDirection;
	previousClose: number;
	price: number;
	todayThreads: number;
}

/**
 * Today's move of a running total: the price (every message) against
 * yesterday's close (the price less the messages in threads active today).
 * The change counts every message of a thread active today, so it is never
 * negative.
 */
function dayMove(threads: InterfaceThread[], days: TickerDay[]): DayMove {
	const today = days.at(-1);
	const price = threads.reduce((sum, thread) => sum + thread.messageCount, 0);
	const change = today?.messages ?? 0;
	const previousClose = price - change;
	return {
		change,
		changePercent: percentChange(change, previousClose),
		direction: directionOf(change),
		previousClose,
		price,
		todayThreads: today?.threads ?? 0,
	};
}

export function tickerStats(threads: InterfaceThread[]): TickerStats {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return {
		attention: counts.attention,
		quiet: counts.quiet,
		threads: threads.length,
		waiting: counts.waiting,
		working: counts.working,
		yourTurn: counts["your-turn"],
	};
}

/** One quote per agent, in snapshot order; sparklines cover `rangeDays`. */
export function buildTickerQuotes(
	snapshot: InterfaceSnapshot,
	now: number,
	rangeDays: number = SPARK_DAYS
): TickerQuote[] {
	const symbols = tickerSymbols(snapshot.agents);
	return snapshot.agents.map((agent) => {
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(byRecency);
		const days = dailyActivity(threads, SPARK_DAYS, now);
		const move = dayMove(threads, days);
		return {
			agent,
			change: move.change,
			changePercent: move.changePercent,
			direction: move.direction,
			groups: snapshot.groups
				.filter((group) => group.memberAgentIds.includes(agent.id))
				.map((group) => group.name),
			lastActive: threads[0]?.updatedAt ?? null,
			previousClose: move.previousClose,
			price: move.price,
			spark: activitySeries(threads, rangeDays, now).buckets.map(
				(day) => day.close
			),
			stats: tickerStats(threads),
			symbol: symbols.get(agent.id) ?? FALLBACK_SYMBOL,
			threads,
			todayThreads: move.todayThreads,
		};
	});
}

/** The whole workspace as one index: every thread, plus how many tickers moved. */
export function tickerIndex(
	snapshot: InterfaceSnapshot,
	quotes: TickerQuote[],
	now: number
): TickerIndex {
	const move = dayMove(
		snapshot.threads,
		dailyActivity(snapshot.threads, 1, now)
	);
	const active = quotes.filter((quote) => quote.todayThreads > 0).length;
	return {
		active,
		change: move.change,
		changePercent: move.changePercent,
		direction: move.direction,
		previousClose: move.previousClose,
		price: move.price,
		quiet: quotes.length - active,
		threads: snapshot.threads.length,
		todayThreads: move.todayThreads,
		working: snapshot.agents.filter((agent) => agent.status === "working")
			.length,
	};
}

function compareQuotes(
	a: TickerQuote,
	b: TickerQuote,
	key: TickerSortKey
): number {
	if (key === "symbol") {
		return a.symbol.localeCompare(b.symbol);
	}
	if (key === "price") {
		return a.price - b.price;
	}
	return (
		a.change - b.change ||
		(a.changePercent ?? Number.POSITIVE_INFINITY) -
			(b.changePercent ?? Number.POSITIVE_INFINITY)
	);
}

/** Sorted copy; ties fall back to the symbol so the order never jitters. */
export function sortQuotes(
	quotes: TickerQuote[],
	sort: TickerSort
): TickerQuote[] {
	const sign = sort.direction === "asc" ? 1 : -1;
	return [...quotes].sort(
		(a, b) =>
			sign * compareQuotes(a, b, sort.key) || a.symbol.localeCompare(b.symbol)
	);
}

/** Clicking the active column flips it; a new column starts on its natural order. */
export function nextSort(current: TickerSort, key: TickerSortKey): TickerSort {
	if (current.key === key) {
		return {
			direction: current.direction === "asc" ? "desc" : "asc",
			key,
		};
	}
	return { direction: key === "symbol" ? "asc" : "desc", key };
}

/** The newest messages across the workspace, newest first. */
export function tapeItems(
	snapshot: InterfaceSnapshot,
	symbols: Map<string, string>,
	limit: number = TAPE_LIMIT
): TickerTapeItem[] {
	return snapshot.threads
		.filter((thread) => (thread.lastMessage ?? "").trim() !== "")
		.sort(byRecency)
		.slice(0, limit)
		.map((thread) => {
			const agentId = thread.agentIds[0] ?? null;
			return {
				agentId,
				id: `tape-${thread.id}`,
				message: (thread.lastMessage ?? "").replace(/\s+/g, " ").trim(),
				role: thread.lastMessageRole,
				symbol: agentId ? (symbols.get(agentId) ?? null) : null,
				threadId: thread.id,
				title: thread.title.trim() || "Untitled thread",
				updatedAt: thread.updatedAt,
			};
		});
}

export interface TickerRun {
	agentId: string | null;
	event: InterfaceEvent;
	symbol: string | null;
}

/** Scheduled runs still ahead, soonest first: the market's "earnings calendar". */
export function upcomingRuns(
	snapshot: InterfaceSnapshot,
	symbols: Map<string, string>,
	now: number,
	limit = 5
): TickerRun[] {
	return (snapshot.events ?? [])
		.filter((event) => {
			const start = Date.parse(event.start);
			return event.kind === "upcoming" && !Number.isNaN(start) && start >= now;
		})
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
		.slice(0, limit)
		.map((event) => ({
			agentId: event.agentId,
			event,
			symbol: event.agentId ? (symbols.get(event.agentId) ?? null) : null,
		}));
}

/** The agent's next scheduled run, if any. */
export function nextRunFor(
	snapshot: InterfaceSnapshot,
	agentId: string,
	now: number
): InterfaceEvent | undefined {
	let next: InterfaceEvent | undefined;
	for (const event of snapshot.events ?? []) {
		const start = Date.parse(event.start);
		if (
			event.agentId === agentId &&
			event.kind === "upcoming" &&
			start >= now &&
			(!next || event.start < next.start)
		) {
			next = event;
		}
	}
	return next;
}

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;

/** "in 5m", "in 3h", "in 2d" (rounded down; "now" under a minute). */
export function countdown(iso: string, now: number): string {
	const minutes = Math.floor((Date.parse(iso) - now) / MINUTE_MS);
	if (Number.isNaN(minutes) || minutes < 1) {
		return "now";
	}
	if (minutes < HOUR_MINUTES) {
		return `in ${minutes}m`;
	}
	const hours = Math.floor(minutes / HOUR_MINUTES);
	if (hours < DAY_HOURS) {
		return `in ${hours}h`;
	}
	return `in ${Math.floor(hours / DAY_HOURS)}d`;
}

/** The agent's thread that most wants opening: live, failed, your turn, newest. */
export function leadThread(quote: TickerQuote): InterfaceThread | undefined {
	const rank: Record<ThreadStatus, number> = {
		attention: 1,
		quiet: 4,
		waiting: 3,
		working: 0,
		"your-turn": 2,
	};
	let best: InterfaceThread | undefined;
	for (const thread of quote.threads) {
		if (!best || rank[threadStatus(thread)] < rank[threadStatus(best)]) {
			best = thread;
		}
	}
	return best;
}
