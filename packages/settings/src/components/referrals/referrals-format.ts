import { activeLocale, numberFormatter } from "@ryu/i18n/lite";
import type { CommissionRule } from "../../utils/api-client.ts";

export const DASHBOARD_KEY = ["affiliate", "dashboard"] as const;
/**
 * The SAME key `ReferralCreditsSection` reads under. React Query dedupes on it,
 * so the pass's two footer numbers cost no second request — and can never
 * disagree with the list of referees rendered a few hundred pixels below them.
 */
export const CREDITS_KEY = ["referrals", "credits"] as const;
const MICRO_USD_PER_USD = 1_000_000;

/**
 * MICRO-USD, not the minor units `formatMoney` takes. Kept apart for the reason
 * `referral-credits-section.tsx` states: a $15 reward through the cents
 * formatter reads as $0.15, which looks like a much worse reward rather than a
 * bug.
 */
export function formatCreditsUsd(
	microUsd: number,
	locale: string = activeLocale()
): string {
	const dollars = microUsd / MICRO_USD_PER_USD;
	return numberFormatter(locale, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: dollars % 1 === 0 ? 0 : 2,
	}).format(dollars);
}

/** Minor units in `currency`, in `locale` (the UI's language by default). */
export function formatMoney(
	minor: number,
	currency: string,
	locale: string = activeLocale()
): string {
	const code = (currency || "usd").toUpperCase();
	try {
		return numberFormatter(locale, {
			style: "currency",
			currency: code,
		}).format(minor / 100);
	} catch {
		// An unknown currency code: the amount in the locale, then the code.
		const amount = numberFormatter(locale, {
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
		}).format(minor / 100);
		return `${amount} ${code}`;
	}
}

const STATUS_VARIANTS = {
	pending: "secondary",
	approved: "default",
	paid: "default",
	reversed: "destructive",
	rejected: "destructive",
} satisfies Record<string, "default" | "secondary" | "outline" | "destructive">;

export function commissionStatusVariant(
	status: string
): "default" | "secondary" | "outline" | "destructive" {
	return (
		Object.entries(STATUS_VARIANTS).find(([key]) => key === status)?.[1] ??
		"outline"
	);
}

export const DEFAULT_RULE: CommissionRule = {
	type: "percent",
	value: 2000,
	recurring: false,
	durationMonths: null,
	fundedBy: "seller",
};
