import {
	type InterfaceAccountTransaction,
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";

/**
 * Bank view model: pure functions over `snapshot.account` and the threads.
 * Every figure here is a sum or a lookup of what the host sent; nothing is
 * estimated, projected, or rounded into a different amount.
 */

/** Micro-units per currency unit (1e6 = 1.00). */
export const MICRO_PER_UNIT = 1_000_000;
/** Days the home spend chart covers, today included. */
export const SPEND_CHART_DAYS = 30;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Money and number formatting
// ---------------------------------------------------------------------------

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, fractionDigits: number) {
	const key = `${currency}:${fractionDigits}`;
	const cached = moneyFormatters.get(key);
	if (cached) {
		return cached;
	}
	let formatter: Intl.NumberFormat;
	try {
		formatter = new Intl.NumberFormat(undefined, {
			currency: currency.toUpperCase(),
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
			style: "currency",
		});
	} catch {
		// An unknown ISO code: plain figures, the code written after them.
		formatter = new Intl.NumberFormat(undefined, {
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
		});
	}
	moneyFormatters.set(key, formatter);
	return formatter;
}

function isKnownCurrency(currency: string): boolean {
	try {
		new Intl.NumberFormat(undefined, {
			currency: currency.toUpperCase(),
			style: "currency",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Amounts under one unit keep four decimals unless they are whole cents, so a
 * $0.0034 run never reads as $0.00 and two different totals never print the
 * same; whole cents and anything from one unit up show the usual two.
 */
function fractionDigitsFor(micro: number): number {
	const size = Math.abs(micro);
	const wholeCents = size % (MICRO_PER_UNIT / 100) === 0;
	return size > 0 && size < MICRO_PER_UNIT && !wholeCents ? 4 : 2;
}

export interface MoneyOptions {
	/** Prefix a `+` (credits in the feed). Spend never carries a minus. */
	plus?: boolean;
}

/** Micro-units as currency: `$18.42`, `$0.0034`, `+$10.00`. */
export function formatMoney(
	micro: number,
	currency: string,
	options: MoneyOptions = {}
): string {
	const units = Math.abs(micro) / MICRO_PER_UNIT;
	const formatter = moneyFormatter(currency, fractionDigitsFor(micro));
	const body = isKnownCurrency(currency)
		? formatter.format(units)
		: `${formatter.format(units)} ${currency.toUpperCase()}`;
	return options.plus ? `+${body}` : body;
}

/** The hero balance split for typesetting: `$18` and `.42`. */
export function moneyParts(
	micro: number,
	currency: string
): { lead: string; fraction: string } {
	const units = micro / MICRO_PER_UNIT;
	const formatter = moneyFormatter(currency, 2);
	let lead = "";
	let fraction = "";
	let afterDecimal = false;
	for (const part of formatter.formatToParts(units)) {
		if (part.type === "decimal") {
			afterDecimal = true;
		}
		if (afterDecimal) {
			fraction += part.value;
		} else {
			lead += part.value;
		}
	}
	if (!isKnownCurrency(currency)) {
		fraction = `${fraction} ${currency.toUpperCase()}`;
	}
	return { fraction: fraction.trimEnd(), lead };
}

const compactFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
	notation: "compact",
});
const countFormatter = new Intl.NumberFormat(undefined);

/** `142.3K` for headline token figures. */
export function formatCompact(value: number): string {
	return compactFormatter.format(value);
}

/** `12,345` for exact counts in the detail sheet. */
export function formatCount(value: number): string {
	return countFormatter.format(value);
}

/** Total tokens for a row, or null when the host sent neither side. */
export function transactionTokens(
	transaction: InterfaceAccountTransaction
): number | null {
	if (transaction.inputTokens === null && transaction.outputTokens === null) {
		return null;
	}
	return (transaction.inputTokens ?? 0) + (transaction.outputTokens ?? 0);
}

/** Spend as a positive micro-unit figure (0 for credits). */
export function spendOf(transaction: InterfaceAccountTransaction): number {
	return transaction.kind === "debit" ? Math.abs(transaction.amount) : 0;
}

/** Credit as a positive micro-unit figure (0 for spend). */
export function creditOf(transaction: InterfaceAccountTransaction): number {
	return transaction.kind === "credit" ? Math.abs(transaction.amount) : 0;
}

/** `1 transaction`, `12 transactions`. */
export function transactionCountLabel(count: number): string {
	return count === 1 ? "1 transaction" : `${count} transactions`;
}

/** Merchant-tile letter: provider, then model, then the label. */
export function merchantInitial(
	transaction: InterfaceAccountTransaction
): string {
	const source =
		transaction.provider?.trim() ||
		transaction.model?.trim() ||
		transaction.label.trim();
	return source.charAt(0).toUpperCase() || "?";
}

/** `claude-sonnet · anthropic · 4.2K tokens`, skipping what is unknown. */
export function transactionSubtitle(
	transaction: InterfaceAccountTransaction
): string {
	const parts: string[] = [];
	if (transaction.model) {
		parts.push(transaction.model);
	}
	if (transaction.provider) {
		parts.push(transaction.provider);
	}
	const tokens = transactionTokens(transaction);
	if (tokens !== null) {
		parts.push(`${formatCompact(tokens)} tokens`);
	}
	if (parts.length === 0) {
		parts.push(transaction.kind === "credit" ? "Credit" : "Spend");
	}
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function timeOf(transaction: InterfaceAccountTransaction): number {
	return Date.parse(transaction.at);
}

/** Newest first, undated rows last; stable for equal times. */
export function sortTransactions(
	transactions: readonly InterfaceAccountTransaction[]
): InterfaceAccountTransaction[] {
	return transactions
		.map((transaction, index) => ({
			index,
			time: timeOf(transaction),
			transaction,
		}))
		.sort((left, right) => {
			const leftTime = Number.isNaN(left.time)
				? Number.NEGATIVE_INFINITY
				: left.time;
			const rightTime = Number.isNaN(right.time)
				? Number.NEGATIVE_INFINITY
				: right.time;
			return rightTime - leftTime || left.index - right.index;
		})
		.map((entry) => entry.transaction);
}

function startOfDay(time: number): Date {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date;
}

function monthKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The statement month (`2026-10`) a transaction falls in, or null undated. */
export function transactionMonth(
	transaction: InterfaceAccountTransaction
): string | null {
	const time = timeOf(transaction);
	return Number.isNaN(time) ? null : monthKey(new Date(time));
}

const dayFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "long",
	weekday: "long",
});
const dayYearFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "long",
	weekday: "long",
	year: "numeric",
});
const shortDayFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});
const shortWeekdayFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	weekday: "short",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const monthFormatter = new Intl.DateTimeFormat(undefined, {
	month: "long",
	year: "numeric",
});

/** `Today`, `Yesterday`, `Monday 12 October` (year added when not this year). */
export function dayLabel(date: Date, now: number): string {
	const today = startOfDay(now);
	const key = localDayKey(date);
	if (key === localDayKey(today)) {
		return "Today";
	}
	if (key === localDayKey(new Date(today.getTime() - DAY_MS / 2))) {
		return "Yesterday";
	}
	return date.getFullYear() === today.getFullYear()
		? dayFormatter.format(date)
		: dayYearFormatter.format(date);
}

/** `3 Oct` for chart axes. */
export function shortDay(date: Date): string {
	return shortDayFormatter.format(date);
}

/** `Tue 13 Oct` for the chart tooltip. */
export function shortWeekday(date: Date): string {
	return shortWeekdayFormatter.format(date);
}

/** `2:05 PM` in the feed. */
export function clockTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : timeFormatter.format(new Date(time));
}

/** `Tuesday 13 October 2026 at 2:05 PM` in the detail sheet. */
export function fullDateTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return "Date unknown";
	}
	const date = new Date(time);
	return `${dayYearFormatter.format(date)} at ${timeFormatter.format(date)}`;
}

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
// Conversation context for a transaction
// ---------------------------------------------------------------------------

export interface BankTransactionContext {
	agents: InterfaceAgent[];
	thread: InterfaceThread;
}

/** The conversation (and its agents) a spend belongs to, when known. */
export function transactionContext(
	snapshot: InterfaceSnapshot,
	transaction: InterfaceAccountTransaction
): BankTransactionContext | null {
	if (!transaction.threadId) {
		return null;
	}
	const thread = snapshot.threads.find(
		(candidate) => candidate.id === transaction.threadId
	);
	if (!thread) {
		return null;
	}
	const agents = thread.agentIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	return { agents, thread };
}

/** `Atlas`, `Atlas and Echo`, `Atlas, Echo and Forge`. */
export function agentNames(agents: readonly InterfaceAgent[]): string {
	const names = agents.map((agent) => agent.name);
	if (names.length <= 1) {
		return names[0] ?? "No agent";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
// Insights: ranked spend
// ---------------------------------------------------------------------------

export type BankPeriod = "this-month" | "last-month";

export const BANK_PERIOD_LABELS: Record<BankPeriod, string> = {
	"last-month": "Last month",
	"this-month": "This month",
};

function inPeriod(
	transaction: InterfaceAccountTransaction,
	period: BankPeriod,
	now: number
): boolean {
	const time = timeOf(transaction);
	if (Number.isNaN(time)) {
		return false;
	}
	const today = new Date(now);
	const target =
		period === "this-month"
			? today
			: new Date(today.getFullYear(), today.getMonth() - 1, 1);
	return monthKey(new Date(time)) === monthKey(target);
}

export interface BankShare {
	/** Transactions counted. */
	count: number;
	/** Secondary line (provider, agents). */
	detail: string | null;
	id: string;
	label: string;
	/**
	 * Not a ranked entry (spend outside conversations, or with no agent):
	 * listed after the ranking instead of inside it.
	 */
	pinned: boolean;
	/** The `Other` row that sums everything past the top of the ranking. */
	rollup?: boolean;
	/** Fraction of the period's spend, 0..1. */
	share: number;
	/** Micro-units spent. */
	spent: number;
	/** Set for conversation rows, so they can open. */
	threadId: string | null;
}

interface ShareSeed {
	count: number;
	detail: string | null;
	label: string;
	pinned: boolean;
	spent: number;
	threadId: string | null;
}

function rank(seeds: Map<string, ShareSeed>): BankShare[] {
	let total = 0;
	for (const seed of seeds.values()) {
		total += seed.spent;
	}
	return [...seeds.entries()]
		.filter(([, seed]) => seed.spent > 0)
		.map(([id, seed]) => ({
			...seed,
			id,
			share: total > 0 ? seed.spent / total : 0,
		}))
		.sort(
			(left, right) =>
				Number(left.pinned) - Number(right.pinned) ||
				right.spent - left.spent ||
				left.label.localeCompare(right.label)
		);
}

function addSeed(
	seeds: Map<string, ShareSeed>,
	id: string,
	fresh: Omit<ShareSeed, "count" | "pinned" | "spent"> & { pinned?: boolean },
	spent: number
) {
	const seed = seeds.get(id) ?? {
		...fresh,
		count: 0,
		pinned: fresh.pinned ?? false,
		spent: 0,
	};
	seed.count += 1;
	seed.spent += spent;
	seeds.set(id, seed);
}

/** Spend per model in the period, largest first. */
export function spendByModel(
	transactions: readonly InterfaceAccountTransaction[],
	period: BankPeriod,
	now: number
): BankShare[] {
	const seeds = new Map<string, ShareSeed>();
	for (const transaction of transactions) {
		if (transaction.kind !== "debit" || !inPeriod(transaction, period, now)) {
			continue;
		}
		const model = transaction.model?.trim() || "Unknown model";
		addSeed(
			seeds,
			`model:${model}:${transaction.provider ?? ""}`,
			{ detail: transaction.provider, label: model, threadId: null },
			spendOf(transaction)
		);
	}
	return rank(seeds);
}

/**
 * Spend per agent in the period, via each spend's conversation. A shared
 * conversation stays one row naming all its agents, so no amount is split or
 * double counted.
 */
export function spendByAgent(
	snapshot: InterfaceSnapshot,
	transactions: readonly InterfaceAccountTransaction[],
	period: BankPeriod,
	now: number
): BankShare[] {
	const seeds = new Map<string, ShareSeed>();
	for (const transaction of transactions) {
		if (transaction.kind !== "debit" || !inPeriod(transaction, period, now)) {
			continue;
		}
		const context = transactionContext(snapshot, transaction);
		const spent = spendOf(transaction);
		if (!context) {
			addSeed(
				seeds,
				"none:conversation",
				{
					detail: null,
					label: "Outside conversations",
					pinned: true,
					threadId: null,
				},
				spent
			);
			continue;
		}
		if (context.agents.length === 0) {
			addSeed(
				seeds,
				"none:agent",
				{ detail: null, label: "No agent", pinned: true, threadId: null },
				spent
			);
			continue;
		}
		const ids = context.agents.map((agent) => agent.id).sort();
		addSeed(
			seeds,
			`agents:${ids.join(",")}`,
			{
				detail: context.agents.length > 1 ? "Shared conversations" : null,
				label: agentNames(context.agents),
				threadId: null,
			},
			spent
		);
	}
	return rank(seeds);
}

/** Spend per conversation in the period, largest first. */
export function spendByConversation(
	snapshot: InterfaceSnapshot,
	transactions: readonly InterfaceAccountTransaction[],
	period: BankPeriod,
	now: number
): BankShare[] {
	const seeds = new Map<string, ShareSeed>();
	for (const transaction of transactions) {
		if (transaction.kind !== "debit" || !inPeriod(transaction, period, now)) {
			continue;
		}
		const context = transactionContext(snapshot, transaction);
		if (!context) {
			continue;
		}
		addSeed(
			seeds,
			`thread:${context.thread.id}`,
			{
				detail: context.agents.length > 0 ? agentNames(context.agents) : null,
				label: context.thread.title.trim() || "Untitled conversation",
				threadId: context.thread.id,
			},
			spendOf(transaction)
		);
	}
	return rank(seeds);
}

/**
 * The top `limit` ranked rows plus one `Other` row summing the rest, so side
 * by side rankings keep the same length; unranked (pinned) rows follow as is.
 */
export function rollupShares(
	shares: readonly BankShare[],
	limit: number
): BankShare[] {
	const ranked = shares.filter((share) => !share.pinned);
	const pinned = shares.filter((share) => share.pinned);
	if (ranked.length <= limit + 1) {
		return [...ranked, ...pinned];
	}
	const rest = ranked.slice(limit);
	const other: BankShare = {
		count: 0,
		detail: `${rest.length} more`,
		id: "rollup:other",
		label: "Other",
		pinned: false,
		rollup: true,
		share: 0,
		spent: 0,
		threadId: null,
	};
	for (const share of rest) {
		other.count += share.count;
		other.share += share.share;
		other.spent += share.spent;
	}
	return [...ranked.slice(0, limit), other, ...pinned];
}

/** Total spend in the period. */
export function periodSpend(
	transactions: readonly InterfaceAccountTransaction[],
	period: BankPeriod,
	now: number
): number {
	let total = 0;
	for (const transaction of transactions) {
		if (inPeriod(transaction, period, now)) {
			total += spendOf(transaction);
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// Statements: one row per calendar month
// ---------------------------------------------------------------------------

export interface BankStatement {
	/** Balance after the month's newest transaction, when the host sent it. */
	closing: number | null;
	count: number;
	credited: number;
	key: string;
	label: string;
	/** Balance after the previous month's newest transaction, when known. */
	opening: number | null;
	/**
	 * The oldest transaction's time when the feed starts after this month
	 * began, so the totals cover only part of it; null for a whole month.
	 */
	partialFrom: number | null;
	/**
	 * Whether opening + in - out lands on closing (null when either balance
	 * is unknown). False flags history the host sent with gaps or drift.
	 */
	reconciles: boolean | null;
	spent: number;
}

/** Rounding slack, in micro-units, before a statement counts as off. */
const RECONCILE_TOLERANCE = 10;

/** Monthly statements, newest month first. */
export function monthlyStatements(
	transactions: readonly InterfaceAccountTransaction[]
): BankStatement[] {
	const statements: BankStatement[] = [];
	const byKey = new Map<string, BankStatement>();
	let oldest = Number.POSITIVE_INFINITY;
	for (const transaction of sortTransactions(transactions)) {
		const time = timeOf(transaction);
		if (Number.isNaN(time)) {
			continue;
		}
		oldest = Math.min(oldest, time);
		const date = new Date(time);
		const key = monthKey(date);
		let statement = byKey.get(key);
		if (!statement) {
			statement = {
				// Newest first, so the first row seen closes the month.
				closing: transaction.balanceAfter,
				count: 0,
				credited: 0,
				key,
				label: monthFormatter.format(date),
				opening: null,
				partialFrom: null,
				reconciles: null,
				spent: 0,
			};
			byKey.set(key, statement);
			statements.push(statement);
		}
		statement.count += 1;
		statement.credited += creditOf(transaction);
		statement.spent += spendOf(transaction);
	}
	for (const [index, statement] of statements.entries()) {
		statement.opening = statements[index + 1]?.closing ?? null;
		if (statement.opening !== null && statement.closing !== null) {
			const expected = statement.opening + statement.credited - statement.spent;
			statement.reconciles =
				Math.abs(expected - statement.closing) <= RECONCILE_TOLERANCE;
		}
	}
	// The feed is capped, so the oldest month may be cut off: flag it when the
	// history begins after that month started instead of passing it as whole.
	const earliest = statements.at(-1);
	if (earliest && Number.isFinite(oldest)) {
		const start = new Date(oldest);
		const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
		if (monthStart.getTime() < oldest) {
			earliest.partialFrom = oldest;
		}
	}
	return statements;
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
