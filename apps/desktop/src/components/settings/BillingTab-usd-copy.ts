// Billing-tab sentences that name a dollar amount. The amount is a formatted
// placeholder ("$0" in English, "0 $" in German) rather than text inside the
// translatable sentence, so a translation never keeps the US form.

import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";

/** The budget that means "no limit" (see `useSandboxRunBudget`). */
const NO_LIMIT_BUDGET_USD = 0;

/** A whole-dollar amount in `locale` (default: the UI language). */
export function wholeUsd(amount: number, locale?: string): string {
	return formatCurrency(
		amount,
		"USD",
		{ maximumFractionDigits: 0, minimumFractionDigits: 0 },
		locale
	);
}

/** The "Sandbox spending" caption, with the zero amount formatted for `locale`. */
export function sandboxBudgetCaption(
	tl: LiteralMessage,
	locale?: string
): string {
	return tl(
		"The most one sandboxed run on this node may cost before Ryu stops it. {zeroAmount} means no limit.",
		{ zeroAmount: wholeUsd(NO_LIMIT_BUDGET_USD, locale) }
	);
}

/** The error for a low-balance threshold that is not above zero. */
export function balanceThresholdError(
	tl: LiteralMessage,
	locale?: string
): string {
	return tl("Set a balance threshold above {zeroAmount}.", {
		zeroAmount: wholeUsd(0, locale),
	});
}

/** The error for an auto-recharge amount outside `minimum`–`maximum` dollars. */
export function rechargeRangeError(
	tl: LiteralMessage,
	minimum: number,
	maximum: number,
	locale?: string
): string {
	return tl("Recharge amount must be between {minimum} and {maximum}.", {
		maximum: wholeUsd(maximum, locale),
		minimum: wholeUsd(minimum, locale),
	});
}

/** {@link sandboxBudgetCaption} in the language the mounting provider shows. */
export function useSandboxBudgetCaption(): string {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	return sandboxBudgetCaption(tl, locale);
}
