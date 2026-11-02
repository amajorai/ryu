import {
	activeLocale,
	dateFormatter,
	numberFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import {
	type InterfaceAccountTransaction,
	localDayKey,
} from "@ryuhq/protocol/interfaces";

/** Bank formatting: money, counts, and the dates the feed and sheets show. */

/** Micro-units per currency unit (1e6 = 1.00). */
export const MICRO_PER_UNIT = 1_000_000;
/** Days the home spend chart covers, today included. */
export const SPEND_CHART_DAYS = 30;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Money and number formatting
// ---------------------------------------------------------------------------

function moneyFormatter(currency: string, fractionDigits: number) {
	const locale = activeLocale();
	if (isKnownCurrency(currency)) {
		return numberFormatter(locale, {
			currency: currency.toUpperCase(),
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
			style: "currency",
		});
	}
	// An unknown ISO code: plain figures, the code written after them.
	return numberFormatter(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
	});
}

const knownCurrencies = new Map<string, boolean>();

function isKnownCurrency(currency: string): boolean {
	const code = currency.toUpperCase();
	let known = knownCurrencies.get(code);
	if (known === undefined) {
		try {
			new Intl.NumberFormat("en", { currency: code, style: "currency" });
			known = true;
		} catch {
			known = false;
		}
		knownCurrencies.set(code, known);
	}
	return known;
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

const COMPACT: Intl.NumberFormatOptions = {
	maximumFractionDigits: 1,
	notation: "compact",
};

/** `142.3K` for headline token figures. */
export function formatCompact(value: number): string {
	return numberFormatter(activeLocale(), COMPACT).format(value);
}

/** `12,345` for exact counts in the detail sheet. */
export function formatCount(value: number): string {
	return numberFormatter(activeLocale()).format(value);
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
	return tr("{count, plural, one {# transaction} other {# transactions}}", {
		count,
	});
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
		parts.push(tr("{tokens} tokens", { tokens: formatCompact(tokens) }));
	}
	if (parts.length === 0) {
		parts.push(transaction.kind === "credit" ? tr("Credit") : tr("Spend"));
	}
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function timeOf(transaction: InterfaceAccountTransaction): number {
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

export function startOfDay(time: number): Date {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date;
}

export function monthKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The statement month (`2026-10`) a transaction falls in, or null undated. */
export function transactionMonth(
	transaction: InterfaceAccountTransaction
): string | null {
	const time = timeOf(transaction);
	return Number.isNaN(time) ? null : monthKey(new Date(time));
}

const dayFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
	});
const dayYearFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
		year: "numeric",
	});
const shortDayFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "short",
	});
const shortWeekdayFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "short",
		weekday: "short",
	});
const timeFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	});
export const monthFormatter = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		month: "long",
		year: "numeric",
	});

/** `Today`, `Yesterday`, `Monday 12 October` (year added when not this year). */
export function dayLabel(date: Date, now: number): string {
	const today = startOfDay(now);
	const key = localDayKey(date);
	if (key === localDayKey(today)) {
		return tr("Today");
	}
	if (key === localDayKey(new Date(today.getTime() - DAY_MS / 2))) {
		return tr("Yesterday");
	}
	return date.getFullYear() === today.getFullYear()
		? dayFormatter().format(date)
		: dayYearFormatter().format(date);
}

/** `3 Oct` for chart axes. */
export function shortDay(date: Date): string {
	return shortDayFormatter().format(date);
}

/** `Tue 13 Oct` for the chart tooltip. */
export function shortWeekday(date: Date): string {
	return shortWeekdayFormatter().format(date);
}

/** `2:05 PM` in the feed. */
export function clockTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : timeFormatter().format(new Date(time));
}

/** `Tuesday 13 October 2026 at 2:05 PM` in the detail sheet. */
export function fullDateTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return tr("Date unknown");
	}
	return dateFormatter(activeLocale(), {
		dateStyle: "full",
		timeStyle: "short",
	}).format(new Date(time));
}
