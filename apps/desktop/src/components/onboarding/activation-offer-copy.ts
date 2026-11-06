// apps/desktop/src/components/onboarding/activation-offer-copy.ts
//
// The price tile on the onboarding value step. The amounts come from the one
// offer and plan price tables (never a hand-built "$50") and are formatted as
// USD in the UI language, so German reads "50 $" and Arabic its own digits.
// Each line that carries words is one whole catalog message.

import { ONBOARDING_TEAMS_OFFER } from "@ryu/auth/lib/onboarding-offer";
import { activeLocale } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	formatOfferPrice,
	PRO_MONTHLY_PRICE_USD,
} from "./activation-offer-terms.ts";

/** The headline amount, the period it covers, and what follows it. */
export interface ActivationOfferCopy {
	amount: string;
	cadence: string;
	recurring: string;
}

/** The Teams (organization) or Pro (personal) price tile, translated by `tl`. */
export function activationOfferCopy(
	tl: LiteralMessage,
	organizationPlan: boolean,
	locale: string = activeLocale()
): ActivationOfferCopy {
	if (organizationPlan) {
		return {
			amount: formatOfferPrice(
				ONBOARDING_TEAMS_OFFER.trialMonthlyPriceUsd,
				locale
			),
			cadence: tl("first month"),
			recurring: tl("{price}/month from month two", {
				price: formatOfferPrice(
					ONBOARDING_TEAMS_OFFER.listMonthlyPriceUsd,
					locale
				),
			}),
		};
	}
	return {
		amount: formatOfferPrice(PRO_MONTHLY_PRICE_USD, locale),
		cadence: tl("per month for one person"),
		recurring: tl("Choose Max later if you need more capacity"),
	};
}
