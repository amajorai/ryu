import {
	type InterfaceAccountTransaction,
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import {
	creditOf,
	dayLabel,
	monthKey,
	SPEND_CHART_DAYS,
	sortTransactions,
	spendOf,
	startOfDay,
	timeOf,
	transactionTokens,
} from "./bank-model-format.ts";

export {
	clockTime,
	creditOf,
	dayLabel,
	formatCompact,
	formatCount,
	formatMoney,
	fullDateTime,
	MICRO_PER_UNIT,
	type MoneyOptions,
	merchantInitial,
	moneyParts,
	SPEND_CHART_DAYS,
	shortDay,
	shortWeekday,
	sortTransactions,
	spendOf,
	transactionCountLabel,
	transactionMonth,
	transactionSubtitle,
	transactionTokens,
} from "./bank-model-format.ts";
export {
	agentNames,
	BANK_PERIOD_LABELS,
	type BankPeriod,
	type BankShare,
	type BankStatement,
	type BankTransactionContext,
	monthlyStatements,
	periodSpend,
	rollupShares,
	spendByAgent,
	spendByConversation,
	spendByModel,
	transactionContext,
} from "./bank-model-insights.ts";

import type { BankTransactionContext } from "./bank-model-insights.ts";

/**
 * Bank view model: pure functions over `snapshot.account` and the threads.
 * Every figure here is a sum or a lookup of what the host sent; nothing is
 * estimated, projected, or rounded into a different amount.
 */

// ---------------------------------------------------------------------------
// Feed: transactions grouped by day
// ---------------------------------------------------------------------------

export interface BankDayGroup {
	/** Micro-units credited that day. */
	credited: number;
	key: string;
	label: string;
	/** Micro-units spent that day (credits excluded). */
	spent: number;
	transactions: InterfaceAccountTransaction[];
}

/** The bank feed: newest day first, each day newest first. */
export function groupByDay(
	transactions: readonly InterfaceAccountTransaction[],
	now: number
): BankDayGroup[] {
	const groups: BankDayGroup[] = [];
	const byKey = new Map<string, BankDayGroup>();
	for (const transaction of sortTransactions(transactions)) {
		const time = timeOf(transaction);
		const dated = !Number.isNaN(time);
		const key = dated ? localDayKey(new Date(time)) : "undated";
		let group = byKey.get(key);
		if (!group) {
			group = {
				credited: 0,
				key,
				label: dated ? dayLabel(new Date(time), now) : "Date unknown",
				spent: 0,
				transactions: [],
			};
			byKey.set(key, group);
			groups.push(group);
		}
		group.transactions.push(transaction);
		group.spent += spendOf(transaction);
		group.credited += creditOf(transaction);
	}
	return groups;
}

/** Case-insensitive match on label, model, provider, and conversation. */
export function matchesQuery(
	transaction: InterfaceAccountTransaction,
	context: BankTransactionContext | null,
	query: string
): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	const haystack = [
		transaction.label,
		transaction.model,
		transaction.provider,
		context?.thread.title,
		...(context?.agents.map((agent) => agent.name) ?? []),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Home figures
// ---------------------------------------------------------------------------

/** Input plus output tokens of this calendar month's spend. */
export function tokensThisMonth(
	transactions: readonly InterfaceAccountTransaction[],
	now: number
): number {
	const current = monthKey(new Date(now));
	let total = 0;
	for (const transaction of transactions) {
		const time = timeOf(transaction);
		if (
			transaction.kind === "debit" &&
			!Number.isNaN(time) &&
			monthKey(new Date(time)) === current
		) {
			total += transactionTokens(transaction) ?? 0;
		}
	}
	return total;
}

export interface BankSpendDay {
	count: number;
	date: Date;
	key: string;
	/** Micro-units spent that day. */
	spent: number;
}

/** Daily spend for the last `days` days, oldest first, today last. */
export function dailySpend(
	transactions: readonly InterfaceAccountTransaction[],
	now: number,
	days: number = SPEND_CHART_DAYS
): BankSpendDay[] {
	const today = startOfDay(now);
	const series: BankSpendDay[] = [];
	const byKey = new Map<string, BankSpendDay>();
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const date = new Date(today);
		date.setDate(today.getDate() - offset);
		const day: BankSpendDay = {
			count: 0,
			date,
			key: localDayKey(date),
			spent: 0,
		};
		series.push(day);
		byKey.set(day.key, day);
	}
	for (const transaction of transactions) {
		const time = timeOf(transaction);
		if (transaction.kind !== "debit" || Number.isNaN(time)) {
			continue;
		}
		const day = byKey.get(localDayKey(new Date(time)));
		if (day) {
			day.spent += spendOf(transaction);
			day.count += 1;
		}
	}
	return series;
}

export interface BankMonthToDate {
	/** Spend so far this calendar month. */
	current: number;
	/** Day of the month `now` falls on (1-based). */
	dayOfMonth: number;
	/** Whether the feed reaches back to the start of last month. */
	hasFullPrevious: boolean;
	/** The oldest transaction's time, or null with no dated history. */
	historyStart: number | null;
	/** Spend over the whole of last month. */
	previous: number;
	/** Last month's spend up to the same day of the month. */
	previousToDate: number;
}

/** Month-to-date spend against last month (whole, and to the same day). */
export function monthToDate(
	transactions: readonly InterfaceAccountTransaction[],
	now: number
): BankMonthToDate {
	const today = new Date(now);
	const currentKey = monthKey(today);
	const previousStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
	const previousKey = monthKey(previousStart);
	const dayOfMonth = today.getDate();
	let current = 0;
	let previous = 0;
	let previousToDate = 0;
	let oldest = Number.POSITIVE_INFINITY;
	for (const transaction of transactions) {
		const time = timeOf(transaction);
		if (Number.isNaN(time)) {
			continue;
		}
		oldest = Math.min(oldest, time);
		const date = new Date(time);
		const key = monthKey(date);
		const spent = spendOf(transaction);
		if (key === currentKey) {
			current += spent;
		} else if (key === previousKey) {
			previous += spent;
			if (date.getDate() <= dayOfMonth) {
				previousToDate += spent;
			}
		}
	}
	return {
		current,
		dayOfMonth,
		hasFullPrevious: oldest <= previousStart.getTime(),
		historyStart: Number.isFinite(oldest) ? oldest : null,
		previous,
		previousToDate,
	};
}

// ---------------------------------------------------------------------------
// Signed out: per-agent activity from threads
// ---------------------------------------------------------------------------

export interface BankAgentActivity {
	agent: InterfaceAgent;
	latest: InterfaceThread | undefined;
	messages: number;
	threads: number;
	working: boolean;
}

/** Each agent's conversations and messages, most recently active first. */
export function agentActivity(
	snapshot: InterfaceSnapshot
): BankAgentActivity[] {
	const rows = snapshot.agents.map((agent) => {
		const threads = snapshot.threads.filter((thread) =>
			thread.agentIds.includes(agent.id)
		);
		let latest: InterfaceThread | undefined;
		let messages = 0;
		for (const thread of threads) {
			messages += thread.messageCount;
			if (
				!latest ||
				Date.parse(thread.updatedAt) > Date.parse(latest.updatedAt)
			) {
				latest = thread;
			}
		}
		return {
			agent,
			latest,
			messages,
			threads: threads.length,
			working:
				agent.status === "working" || threads.some((thread) => thread.running),
		};
	});
	return rows.sort((left, right) => {
		const leftTime = left.latest ? Date.parse(left.latest.updatedAt) : 0;
		const rightTime = right.latest ? Date.parse(right.latest.updatedAt) : 0;
		return (
			rightTime - leftTime || left.agent.name.localeCompare(right.agent.name)
		);
	});
}

/** Steps a chart's top tick may land on, per power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * The smallest "nice" value at or above `value` (1, 2, 2.5, or 5 times a power
 * of ten), so a chart's top tick reads `$0.01` rather than the raw `$0.0092`.
 */
export function niceCeiling(value: number): number {
	if (!(value > 0 && Number.isFinite(value))) {
		return 0;
	}
	const magnitude = 10 ** Math.floor(Math.log10(value));
	for (const step of NICE_STEPS) {
		const candidate = step * magnitude;
		if (candidate >= value * (1 - Number.EPSILON)) {
			return Math.round(candidate * 1e6) / 1e6;
		}
	}
	return 10 * magnitude;
}
