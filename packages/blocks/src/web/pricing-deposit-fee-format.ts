// The published deposit-fee rates and amounts, formatted for the reader's
// locale ("27%" and "$5" in English, "27 %" and "5 $" in German).
// `PRICING_COPY` keeps the English strings the docs drift tests compare.

import { formatNumberValue } from "@ryu/i18n/format-intl";
import { PUBLISHED_PRICING } from "./data/standalone-pricing.ts";

const BPS_PER_UNIT = 10_000;

export interface DepositFeeAmounts {
	baseDepositFee: string;
	depositFeeCap: string;
	depositFeeMinimum: string;
	proDepositFee: string;
	teamDepositFee: string;
}

function percentFromBps(locale: string, bps: number): string {
	return formatNumberValue(locale, bps / BPS_PER_UNIT, {
		maximumFractionDigits: 2,
		style: "percent",
	});
}

function wholeUsd(locale: string, amount: number): string {
	return formatNumberValue(locale, amount, {
		currency: "USD",
		maximumFractionDigits: 0,
		minimumFractionDigits: 0,
		style: "currency",
	});
}

/** Every deposit-fee figure the pricing pages quote, in `locale`. */
export function depositFeeAmounts(locale = "en"): DepositFeeAmounts {
	const { depositFee } = PUBLISHED_PRICING;
	return {
		baseDepositFee: percentFromBps(locale, depositFee.baseBps),
		depositFeeCap: wholeUsd(locale, depositFee.marginCapUsd),
		depositFeeMinimum: wholeUsd(locale, depositFee.minimumUsd),
		proDepositFee: percentFromBps(locale, depositFee.proBps),
		teamDepositFee: percentFromBps(locale, depositFee.teamBps),
	};
}
