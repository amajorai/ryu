import { activeLocale, translate as tr } from "@ryu/i18n/lite";
import type {
	InterfaceAccountTransaction,
	InterfaceAgent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	creditOf,
	monthFormatter,
	monthKey,
	sortTransactions,
	spendOf,
	timeOf,
} from "./bank-model-format.ts";
import { formatNameList } from "./interface-renderer.ts";

/** Bank insights and statements: ranked spend per period and monthly rollups. */

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

/** `Atlas`, `Atlas and Echo`, `Atlas, Echo, and Forge`, in the UI locale. */
export function agentNames(
	agents: readonly InterfaceAgent[],
	locale: string = activeLocale()
): string {
	if (agents.length === 0) {
		return tr("No agent");
	}
	return formatNameList(
		agents.map((agent) => agent.name),
		locale
	);
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
		const model = transaction.model?.trim() || tr("Unknown model");
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
				label: context.thread.title.trim() || tr("Untitled conversation"),
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
		detail: tr("{count} more", { count: rest.length }),
		id: "rollup:other",
		label: tr("Other"),
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
				label: monthFormatter().format(date),
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
