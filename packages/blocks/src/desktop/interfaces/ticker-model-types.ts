import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";

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
