// The "Add credits" caption of the desktop Credits tab. The minimum deposit
// fee and the most Ryu keeps from a top-up are pricing policy, so they are
// read from the shared plan constants (a policy change updates the copy) and
// formatted for the UI language ("$5" in English, "5 $" in German) instead of
// being written into the translatable sentence.

import {
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DEPOSIT_MARGIN_CAP_MICRO_USD,
} from "@ryu/auth/lib/plans";
import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { formatCurrency } from "@ryu/ui/lib/number-format.ts";

const MICRO_USD_PER_USD = 1_000_000;

const WHOLE_DOLLARS: Intl.NumberFormatOptions = {
	maximumFractionDigits: 0,
	minimumFractionDigits: 0,
};

/** A whole-dollar policy amount in `locale` (default: the UI language). */
function policyUsd(microUsd: number, locale?: string): string {
	return formatCurrency(
		microUsd / MICRO_USD_PER_USD,
		"USD",
		WHOLE_DOLLARS,
		locale
	);
}

/** The caption under "Add credits" while billing is configured. */
export function topupFeeCaption(tl: LiteralMessage, locale?: string): string {
	return tl(
		"You'll complete payment in your browser via Polar. The exact plan percentage or {minimumFee} minimum deposit fee is shown before payment, and Ryu keeps at most {marginCap} of it; your wallet is credited the face value. Your balance updates here once it clears.",
		{
			marginCap: policyUsd(DEPOSIT_MARGIN_CAP_MICRO_USD, locale),
			minimumFee: policyUsd(DEPOSIT_FEE_FIXED_MICRO_USD, locale),
		}
	);
}

/** {@link topupFeeCaption} in the language the mounting provider shows. */
export function useTopupFeeCaption(): string {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	return topupFeeCaption(tl, locale);
}
