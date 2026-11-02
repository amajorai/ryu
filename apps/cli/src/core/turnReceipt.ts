// Pure formatters for the per-turn receipt line and the session usage meter
// (opencode's "Agent · Model · 12s" footer and "12.3K (8%) · $0.42" status).
// Every segment is optional: a value Core did not report is left out instead
// of printed as zero or "default".

import {
	formatCliCompact,
	formatCliElapsed,
	formatCliNumber,
} from "../i18n/format.ts";
import { CLI_FORMAT_LOCALE, tf } from "../i18n/translate.ts";
import { isUsageSnapshot, type TurnUsage } from "./chatStream.ts";

/** Joins receipt and meter segments. */
export const RECEIPT_SEPARATOR = " · ";

/** Combine a new snapshot onto the turn's previous one. Snapshots replace
 * field by field; they never add up (ACP re-sends cumulative values). */
export function mergeUsage(
	previous: TurnUsage | undefined,
	next: TurnUsage
): TurnUsage {
	return previous ? { ...previous, ...next } : next;
}

/** 950 -> "950", 1234 -> "1.2K", 12300 -> "12.3K", 2_500_000 -> "2.5M"
 * (in English; other locales use their own compact notation). */
export function formatTokenCount(
	tokens: number,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return formatCliCompact(Math.max(0, Math.round(tokens)), locale);
}

/** 840 -> "0.8s", 12_400 -> "12.4s", 65_000 -> "1m 5s", 120_000 -> "2m". */
export function formatDuration(
	ms: number,
	locale: string = CLI_FORMAT_LOCALE
): string {
	return formatCliElapsed(ms, { trimZeros: true }, locale);
}

/** "$0.42" for USD (or an unnamed currency), "0.42 EUR" otherwise, with the
 * locale's separators (and currency placement for USD). */
export function formatCost(
	amount: number,
	currency?: string,
	locale: string = CLI_FORMAT_LOCALE
): string {
	const digits = amount > 0 && amount < 0.01 ? 4 : 2;
	const options: Intl.NumberFormatOptions = {
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
	};
	const code = currency?.toUpperCase();
	if (!code || code === "USD") {
		return formatCliNumber(
			amount,
			{
				...options,
				currency: "USD",
				// "$" in every locale (en-GB would otherwise print "US$", en-AU "USD").
				currencyDisplay: "narrowSymbol",
				style: "currency",
			},
			locale
		);
	}
	return `${formatCliNumber(amount, options, locale)} ${code}`;
}

/** Tokens per second: whole above 10, one decimal below. */
function formatSpeed(speed: number, locale: string): string {
	return formatCliNumber(
		speed,
		{ maximumFractionDigits: speed >= 10 ? 0 : 1, useGrouping: false },
		locale
	);
}

/** Tokens this turn consumed: the reported total, else input + output, else
 * whichever side was reported. */
export function turnTokens(usage: TurnUsage | undefined): number | undefined {
	if (!usage) {
		return;
	}
	if (usage.totalTokens !== undefined) {
		return usage.totalTokens;
	}
	const { inputTokens, outputTokens } = usage;
	if (inputTokens !== undefined && outputTokens !== undefined) {
		return inputTokens + outputTokens;
	}
	return outputTokens ?? inputTokens;
}

const positive = (value: number | undefined): number | undefined =>
	value !== undefined && value > 0 ? value : undefined;

export interface TurnReceiptInput {
	agentLabel?: string | null;
	/** Wall-clock turn time measured by the TUI, used when Core sent none. */
	elapsedMs?: number;
	/** Number locale; defaults to the CLI's (`RYU_LOCALE`). */
	locale?: string;
	modelLabel?: string | null;
	usage?: TurnUsage;
}

/** The receipt split in two: who answered (`agent · model`), which may be
 * truncated in a narrow pane, and the numbers (`12.4s · 1.2K tok · 38 tok/s`),
 * which always stay whole. Either is empty when nothing is known. */
export interface TurnReceiptParts {
	identity: string;
	stats: string;
}

export function turnReceiptParts({
	agentLabel,
	modelLabel,
	usage,
	elapsedMs,
	locale = CLI_FORMAT_LOCALE,
}: TurnReceiptInput): TurnReceiptParts {
	const identity: string[] = [];
	if (agentLabel) {
		identity.push(agentLabel);
	}
	if (modelLabel) {
		identity.push(modelLabel);
	}
	const stats: string[] = [];
	const duration = usage?.durationMs ?? elapsedMs;
	if (duration !== undefined) {
		stats.push(formatDuration(duration, locale));
	}
	const tokens = positive(turnTokens(usage));
	if (tokens !== undefined) {
		stats.push(tf("{count} tok", { count: formatTokenCount(tokens, locale) }));
	}
	const speed = positive(usage?.tokensPerSecond);
	if (speed !== undefined) {
		stats.push(tf("{rate} tok/s", { rate: formatSpeed(speed, locale) }));
	}
	return {
		identity: identity.join(RECEIPT_SEPARATOR),
		stats: stats.join(RECEIPT_SEPARATOR),
	};
}

/** `agent · model · 12.4s · 1.2K tok · 38 tok/s`, omitting unknown parts.
 * Returns an empty string when nothing is known. */
export function formatTurnReceipt(input: TurnReceiptInput): string {
	const { identity, stats } = turnReceiptParts(input);
	return [identity, stats].filter(Boolean).join(RECEIPT_SEPARATOR);
}

export interface SessionUsage {
	contextTotal?: number;
	contextUsed?: number;
	costAmount?: number;
	costCurrency?: string;
	tokens?: number;
}

/**
 * Fold every turn's usage into conversation totals. Context occupancy and
 * meter (ACP or Core) session cost/tokens are cumulative snapshots, so the latest wins; a
 * local-engine turn's tokens and cost are per turn, so those add up.
 */
export function summarizeSessionUsage(
	turns: readonly (TurnUsage | undefined)[]
): SessionUsage {
	let contextUsed: number | undefined;
	let contextTotal: number | undefined;
	let sessionTokens: number | undefined;
	let summedTokens: number | undefined;
	let acpCost: number | undefined;
	let summedCost: number | undefined;
	let costCurrency: string | undefined;
	for (const usage of turns) {
		if (!usage) {
			continue;
		}
		contextUsed = usage.contextUsed ?? contextUsed;
		contextTotal = usage.contextTotal ?? contextTotal;
		sessionTokens = usage.sessionTotalTokens ?? sessionTokens;
		const tokens = turnTokens(usage);
		if (tokens !== undefined) {
			summedTokens = (summedTokens ?? 0) + tokens;
		}
		if (usage.costAmount !== undefined) {
			if (isUsageSnapshot(usage.source)) {
				acpCost = usage.costAmount;
			} else {
				summedCost = (summedCost ?? 0) + usage.costAmount;
			}
			costCurrency = usage.costCurrency ?? costCurrency;
		}
	}
	const costAmount =
		acpCost === undefined && summedCost === undefined
			? undefined
			: (acpCost ?? 0) + (summedCost ?? 0);
	const summary: SessionUsage = {};
	const tokens = contextUsed ?? sessionTokens ?? summedTokens;
	if (tokens !== undefined) {
		summary.tokens = tokens;
	}
	if (contextUsed !== undefined) {
		summary.contextUsed = contextUsed;
	}
	if (contextTotal !== undefined) {
		summary.contextTotal = contextTotal;
	}
	if (costAmount !== undefined) {
		summary.costAmount = costAmount;
	}
	if (costCurrency !== undefined) {
		summary.costCurrency = costCurrency;
	}
	return summary;
}

/** `12.3K (8%) · $0.42`; the % needs a context window and the cost needs a
 * reported amount. Returns an empty string when nothing is known. */
export function formatSessionMeter(
	session: SessionUsage,
	locale: string = CLI_FORMAT_LOCALE
): string {
	const segments: string[] = [];
	if (session.tokens !== undefined) {
		const { contextTotal, contextUsed } = session;
		const percent =
			contextUsed !== undefined &&
			contextTotal !== undefined &&
			contextTotal > 0
				? ` (${formatCliNumber(contextUsed / contextTotal, { maximumFractionDigits: 0, style: "percent" }, locale)})`
				: "";
		segments.push(`${formatTokenCount(session.tokens, locale)}${percent}`);
	}
	if (session.costAmount !== undefined) {
		segments.push(formatCost(session.costAmount, session.costCurrency, locale));
	}
	return segments.join(RECEIPT_SEPARATOR);
}
