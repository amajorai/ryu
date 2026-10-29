import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

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

export type TickerDirection = "down" | "flat" | "up";

export interface TickerDay {
	/**
	 * The "closing price": messages across every thread last active on or
	 * before this day, so a series of days reads as a running total.
	 */
	close: number;
	/** Local midnight of the day, in epoch milliseconds. */
	date: number;
	/** Local `YYYY-MM-DD`. */
	key: string;
	/** Messages in the threads last active that day. */
	messages: number;
	/** Threads last active that day. */
	threads: number;
}

export interface TickerStats {
	attention: number;
	quiet: number;
	threads: number;
	waiting: number;
	working: number;
	yourTurn: number;
}

export interface TickerQuote {
	agent: InterfaceAgent;
	/** Day change in messages: the price minus the previous close. */
	change: number;
	/** Percent of the previous close, or null when it was zero. */
	changePercent: number | null;
	direction: TickerDirection;
	/** Team and project names the agent belongs to. */
	groups: string[];
	/** ISO time of the newest thread activity, or null with no threads. */
	lastActive: string | null;
	/** The price at the end of yesterday. */
	previousClose: number;
	/** Total messages across the agent's threads. */
	price: number;
	/**
	 * Closes across the selected range, oldest first, narrowed to the stretch
	 * with activity (see `activitySeries`).
	 */
	spark: number[];
	stats: TickerStats;
	symbol: string;
	/** The agent's threads, newest first. */
	threads: InterfaceThread[];
	/** Threads last active today. */
	todayThreads: number;
}

export interface TickerIndex {
	/** Tickers with at least one thread active today. */
	active: number;
	change: number;
	changePercent: number | null;
	direction: TickerDirection;
	previousClose: number;
	/** Messages across every thread in the workspace. */
	price: number;
	/** Tickers with no thread active today. */
	quiet: number;
	threads: number;
	/** Threads last active today. */
	todayThreads: number;
	working: number;
}

export interface TickerTapeItem {
	/** The thread's first agent, when it has one. */
	agentId: string | null;
	id: string;
	message: string;
	role: InterfaceThread["lastMessageRole"];
	symbol: string | null;
	threadId: string;
	title: string;
	updatedAt: string;
}

export type TickerSortKey = "change" | "price" | "symbol";
export type TickerSortDirection = "asc" | "desc";

export interface TickerSort {
	direction: TickerSortDirection;
	key: TickerSortKey;
}

export const DEFAULT_TICKER_SORT: TickerSort = {
	direction: "desc",
	key: "price",
};

/** Ranges the detail chart offers, in days. */
export const TICKER_RANGES = [7, 14, 30] as const;
export type TickerRange = (typeof TICKER_RANGES)[number];
export const DEFAULT_TICKER_RANGE: TickerRange = 14;
export const TICKER_RANGE_LABELS: Record<TickerRange, string> = {
	7: "1W",
	14: "2W",
	30: "1M",
};
/** Spoken names of the ranges, for the range buttons and column headers. */
export const TICKER_RANGE_NAMES: Record<TickerRange, string> = {
	7: "1 week",
	14: "2 weeks",
	30: "1 month",
};
/** Printed period of each range, under the hero price. */
export const TICKER_RANGE_PERIODS: Record<TickerRange, string> = {
	7: "Past week",
	14: "Past 2 weeks",
	30: "Past month",
};

export const SPARK_DAYS = 7;
const TAPE_LIMIT = 16;
const MIN_SYMBOL = 3;
const MAX_SYMBOL = 4;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FALLBACK_SYMBOL = "AGT";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** Upper-case ASCII letter words of a name ("Café Bot 2" → ["CAFE", "BOT"]). */
function letterWords(name: string): string[] {
	return name
		.normalize("NFKD")
		.toUpperCase()
		.split(/[^A-Z]+/)
		.filter(Boolean);
}

/** Every 3- and 4-letter in-order pick from `letters` that starts with its first. */
function* letterPicks(letters: string): Generator<string> {
	const head = letters[0] ?? "";
	const rest = letters.slice(1);
	for (let first = 0; first < rest.length; first++) {
		for (let second = first + 1; second < rest.length; second++) {
			yield `${head}${rest[first]}${rest[second]}`;
		}
	}
	for (let first = 0; first < rest.length; first++) {
		for (let second = first + 1; second < rest.length; second++) {
			for (let third = second + 1; third < rest.length; third++) {
				yield `${head}${rest[first]}${rest[second]}${rest[third]}`;
			}
		}
	}
}

/**
 * Symbol candidates for a name, best first: initials for multi-word names, the
 * whole name when it is already 3–4 letters, then its consonant skeleton
 * ("Forge" → FRG, "Cipher" → CPHR), then plain prefixes, then other in-order
 * letter picks.
 */
export function symbolCandidates(name: string): string[] {
	const words = letterWords(name);
	const letters = words.join("");
	const candidates: string[] = [];
	if (words.length > 1) {
		const initials = words.map((word) => word[0]).join("");
		const last = words.at(-1) ?? "";
		candidates.push(
			initials.length >= MIN_SYMBOL
				? initials.slice(0, MAX_SYMBOL)
				: `${initials}${last.slice(1, 1 + MIN_SYMBOL - initials.length)}`
		);
	}
	if (letters.length >= MIN_SYMBOL && letters.length <= MAX_SYMBOL) {
		candidates.push(letters);
	}
	const skeleton = `${letters.slice(0, 1)}${letters.slice(1).replace(/[AEIOUY]/g, "")}`;
	candidates.push(skeleton.slice(0, MAX_SYMBOL), letters.slice(0, MIN_SYMBOL));
	candidates.push(letters.slice(0, MAX_SYMBOL));
	candidates.push(...letterPicks(letters.slice(0, 10)));
	const valid = candidates.filter(
		(candidate) =>
			candidate.length >= MIN_SYMBOL && candidate.length <= MAX_SYMBOL
	);
	return [...new Set(valid)];
}

/**
 * A unique 3–4 letter symbol per agent, assigned in snapshot order so an agent
 * keeps its symbol when newer agents arrive. Names too short or without Latin
 * letters fall back to their letters padded from `AGT`, then a letter suffix.
 */
export function tickerSymbols(agents: InterfaceAgent[]): Map<string, string> {
	const taken = new Set<string>();
	const symbols = new Map<string, string>();
	for (const agent of agents) {
		const letters = letterWords(agent.name).join("");
		const base = `${letters}${FALLBACK_SYMBOL}`.slice(0, MIN_SYMBOL);
		let symbol = symbolCandidates(agent.name).find(
			(candidate) => !taken.has(candidate)
		);
		for (const suffix of ALPHABET) {
			if (symbol) {
				break;
			}
			const candidate = `${base}${suffix}`;
			symbol = taken.has(candidate) ? undefined : candidate;
		}
		for (const first of ALPHABET) {
			for (const second of ALPHABET) {
				if (symbol) {
					break;
				}
				const candidate = `${base.slice(0, 2)}${first}${second}`;
				symbol = taken.has(candidate) ? undefined : candidate;
			}
		}
		const resolved = symbol ?? `${base}${taken.size}`;
		taken.add(resolved);
		symbols.set(agent.id, resolved);
	}
	return symbols;
}

// ---------------------------------------------------------------------------
// Activity and quotes
// ---------------------------------------------------------------------------

/** Local midnight `offset` days from the day of `now` (negative = past). */
function dayStart(now: number, offset: number): Date {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + offset);
	return date;
}

/**
 * Threads (and their messages) last active on each of the `days` days ending
 * today, oldest first, with each day's running "close". Threads only carry
 * their newest activity time, so a thread counts once, on its latest day;
 * threads last active before the range seed the opening price.
 */
export function dailyActivity(
	threads: InterfaceThread[],
	days: number,
	now: number
): TickerDay[] {
	const buckets: TickerDay[] = [];
	const byKey = new Map<string, TickerDay>();
	for (let offset = 1 - days; offset <= 0; offset++) {
		const date = dayStart(now, offset);
		const day: TickerDay = {
			close: 0,
			date: date.getTime(),
			key: localDayKey(date),
			messages: 0,
			threads: 0,
		};
		buckets.push(day);
		byKey.set(day.key, day);
	}
	const rangeStart = buckets[0]?.date ?? 0;
	let opening = 0;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (Number.isNaN(at)) {
			continue;
		}
		const day = byKey.get(localDayKey(new Date(at)));
		if (day) {
			day.threads += 1;
			day.messages += thread.messageCount;
		} else if (at < rangeStart) {
			opening += thread.messageCount;
		}
	}
	let running = opening;
	for (const day of buckets) {
		running += day.messages;
		day.close = running;
	}
	return buckets;
}

const MINUTE_SPAN = 60_000;
const HOUR_SPAN = 60 * MINUTE_SPAN;
const DAY_SPAN = 24 * HOUR_SPAN;
/** Bucket sizes a narrowed series may use, smallest first. */
const BUCKET_STEPS = [
	MINUTE_SPAN,
	2 * MINUTE_SPAN,
	5 * MINUTE_SPAN,
	10 * MINUTE_SPAN,
	15 * MINUTE_SPAN,
	30 * MINUTE_SPAN,
	HOUR_SPAN,
	2 * HOUR_SPAN,
	3 * HOUR_SPAN,
	6 * HOUR_SPAN,
	12 * HOUR_SPAN,
] as const;
/** Most buckets a narrowed series draws; enough for a smooth line. */
const MAX_BUCKETS = 24;
/** The narrowest window a series shows, so two close events still read as a move. */
const MIN_WINDOW = 30 * MINUTE_SPAN;
/** The window reaches this far past the first activity, as a share of its age. */
const LEAD_RATIO = 0.5;

export interface TickerSeries {
	/** Buckets oldest first; each `date` is the bucket's start. */
	buckets: TickerDay[];
	/** Whether the series starts after the range does (the range was mostly quiet). */
	narrowed: boolean;
	/** The price before the first bucket. */
	opening: number;
	/** Whole local days, or equal slices of time ending now. */
	unit: "day" | "time";
}

/**
 * A price series for a chart over the last `rangeDays` days that never draws
 * the degenerate "flat for weeks, then a wall today" shape. Threads only carry
 * their newest activity time, so a series starts shortly before the first
 * activity in the range: whole days when that still spans days, else equal
 * slices of time (1 minute to 12 hours) ending now. A quiet range keeps
 * every day, flat at the opening price.
 */
export function activitySeries(
	threads: InterfaceThread[],
	rangeDays: number,
	now: number
): TickerSeries {
	const rangeStart = dayStart(now, 1 - rangeDays).getTime();
	let first = Number.POSITIVE_INFINITY;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (!Number.isNaN(at) && at >= rangeStart && at <= now) {
			first = Math.min(first, at);
		}
	}
	const daily = (days: number): TickerSeries => {
		const buckets = dailyActivity(threads, days, now);
		return {
			buckets,
			narrowed: days < rangeDays,
			opening: openingPrice(buckets),
			unit: "day",
		};
	};
	if (first === Number.POSITIVE_INFINITY) {
		return daily(rangeDays);
	}
	const window = Math.max(MIN_WINDOW, (now - first) * (1 + LEAD_RATIO));
	const step = BUCKET_STEPS.find((size) => window / size <= MAX_BUCKETS);
	if (step === undefined) {
		const days = Math.min(rangeDays, Math.ceil(window / DAY_SPAN) + 1);
		return daily(days);
	}
	const count = Math.ceil(window / step);
	const start = now - count * step;
	const buckets: TickerDay[] = [];
	for (let index = 0; index < count; index++) {
		const date = start + index * step;
		buckets.push({
			close: 0,
			date,
			key: `t${date}`,
			messages: 0,
			threads: 0,
		});
	}
	let opening = 0;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (Number.isNaN(at)) {
			continue;
		}
		if (at < start) {
			opening += thread.messageCount;
			continue;
		}
		const bucket =
			buckets[Math.min(count - 1, Math.floor((at - start) / step))];
		if (bucket) {
			bucket.threads += 1;
			bucket.messages += thread.messageCount;
		}
	}
	let running = opening;
	for (const bucket of buckets) {
		running += bucket.messages;
		bucket.close = running;
	}
	return { buckets, narrowed: true, opening, unit: "time" };
}

/**
 * What a chart's caption calls the window it draws: the range ("Past 2
 * weeks") when the whole range is drawn, else where the narrowed series
 * starts ("Since 22:35", "Since Sun 17:09", "Since Oct 4"), so the caption
 * always matches the x-axis.
 */
export function seriesPeriod(
	series: TickerSeries,
	range: TickerRange,
	now: number
): string {
	const first = series.buckets[0];
	if (!(series.narrowed && first)) {
		return TICKER_RANGE_PERIODS[range];
	}
	if (series.unit === "day") {
		return `Since ${formatShortDay(first.date)}`;
	}
	return now - first.date > DAY_SPAN
		? `Since ${formatWeekdayClock(first.date)}`
		: `Since ${formatClock(first.date)}`;
}

/** The price before the first day of a series: its "previous close". */
export function openingPrice(days: TickerDay[]): number {
	const first = days[0];
	return first ? first.close - first.messages : 0;
}

/** A series' move over its whole range: up when the price grew. */
export function seriesDirection(days: TickerDay[]): TickerDirection {
	const last = days.at(-1);
	return last ? directionOf(last.close - openingPrice(days)) : "flat";
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function directionOf(change: number): TickerDirection {
	if (change > 0) {
		return "up";
	}
	return change < 0 ? "down" : "flat";
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = "−";
const integerFormat = new Intl.NumberFormat("en-US");
const percentFormat = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
});

export function formatPrice(value: number): string {
	return integerFormat.format(value);
}

/** "+2", "−1", "0" with a true minus sign. */
export function formatChange(value: number): string {
	if (value > 0) {
		return `+${integerFormat.format(value)}`;
	}
	if (value < 0) {
		return `${MINUS}${integerFormat.format(-value)}`;
	}
	return "0";
}

/** "+100.0%", "−50.0%", "0.0%"; null (no previous close) reads "—". */
export function formatPercent(value: number | null): string {
	if (value === null) {
		return "—";
	}
	if (value > 0) {
		return `+${percentFormat.format(value)}%`;
	}
	if (value < 0) {
		return `${MINUS}${percentFormat.format(-value)}%`;
	}
	return `${percentFormat.format(0)}%`;
}

/**
 * Spoken change, e.g. "up 2 messages in threads active today, 7.1 percent".
 * It names what is counted: every message of a thread last active today,
 * since threads do not date their individual messages.
 */
export function describeChange(
	change: number,
	changePercent: number | null
): string {
	if (change === 0) {
		return "no threads active today";
	}
	const amount = Math.abs(change);
	const noun = amount === 1 ? "message" : "messages";
	const percent =
		changePercent === null
			? "none before today"
			: `${percentFormat.format(Math.abs(changePercent))} percent`;
	return `${change > 0 ? "up" : "down"} ${integerFormat.format(amount)} ${noun} in threads active today, ${percent}`;
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	weekday: "short",
});
const shortDayFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
});

export function formatDay(date: number): string {
	return dayFormat.format(new Date(date));
}

export function formatShortDay(date: number): string {
	return shortDayFormat.format(new Date(date));
}

const clockFormat = new Intl.DateTimeFormat("en-US", {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** "22:15", 24-hour. */
export function formatClock(date: number): string {
	return clockFormat.format(new Date(date));
}

/** "Wed 22:15". */
export function formatWeekdayClock(date: number): string {
	const value = new Date(date);
	return `${weekdayFormat.format(value)} ${clockFormat.format(value)}`;
}

const SPOKEN_UNITS: Record<string, string> = {
	d: "day",
	h: "hour",
	m: "minute",
	s: "second",
	w: "week",
};

/** A compact age ("5m") read aloud: "5 minutes ago"; "now" is "just now". */
export function spokenAge(age: string): string {
	const match = age.match(/^(\d+)([smhdw])$/);
	if (!match) {
		return age === "now" ? "just now" : age;
	}
	const count = Number(match[1]);
	const unit = SPOKEN_UNITS[match[2] ?? ""] ?? "";
	return `${count} ${count === 1 ? unit : `${unit}s`} ago`;
}

export function plural(count: number, noun: string): string {
	return `${integerFormat.format(count)} ${count === 1 ? noun : `${noun}s`}`;
}
