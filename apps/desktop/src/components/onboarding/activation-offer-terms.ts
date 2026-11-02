// apps/desktop/src/components/onboarding/activation-offer-terms.ts
//
// The renewal disclosure the onboarding checkout shows above its consent box.
// Each clause is one whole catalog message: the prices arrive as currency
// values formatted in the UI language and the seat count as an ICU plural, so
// a translated agreement never wraps an English legal sentence.

import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { PLAN_MONTHLY_PRICE_MICRO_USD } from "@ryu/auth/lib/plans";
import { activeLocale } from "@ryu/i18n/core";
import { formatNumberValue } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

const MICRO_USD_PER_USD = 1_000_000;

/** Ryu Pro's monthly list price, read from the one plan price table. */
export const PRO_MONTHLY_PRICE_USD =
	PLAN_MONTHLY_PRICE_MICRO_USD.pro / MICRO_USD_PER_USD;

/** "$49" / "49 $" / "49 US$": whole dollars without cents, cents when present. */
export function formatOfferPrice(
	usd: number,
	locale: string = activeLocale()
): string {
	const digits = Number.isInteger(usd) ? 0 : 2;
	return formatNumberValue(locale, usd, {
		currency: "USD",
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
		style: "currency",
	});
}

/** The Teams or Pro renewal terms, translated through `tl`. */
export function activationOfferTerms(
	tl: LiteralMessage,
	organizationPlan: boolean,
	locale: string = activeLocale()
): string {
	if (!organizationPlan) {
		return tl(
			"Renews automatically at {price} every month, plus applicable taxes, until canceled.",
			{ price: formatOfferPrice(PRO_MONTHLY_PRICE_USD, locale) }
		);
	}
	const {
		firstMonthCreditPoolUsd,
		includedSeats,
		listMonthlyPriceUsd,
		trialMonthlyPriceUsd,
	} = ONBOARDING_TEAMS_OFFER;
	return tl(
		"{trialPrice} for the first month, then renews automatically at {listPrice} every month for {includedSeats, plural, one {# seat} other {# seats}}, plus applicable taxes, until canceled. The first month includes a {creditPool} shared credit pool; the offer is limited to one organization per account owner.",
		{
			creditPool: formatOfferPrice(firstMonthCreditPoolUsd, locale),
			includedSeats,
			listPrice: formatOfferPrice(listMonthlyPriceUsd, locale),
			trialPrice: formatOfferPrice(trialMonthlyPriceUsd, locale),
		}
	);
}
