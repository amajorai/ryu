"use client";

import { useOptionalI18n, useRichLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import {
	type PricingFormat,
	pricingFormat,
} from "./data/standalone-pricing-locale.ts";

/**
 * The pricing formatters for the page's UI language: grouped counts and USD
 * amounts in that locale's own digits and separators ("5.000" in German).
 * English, and no provider at all, keep the published copy ("5,000").
 */
export function usePricingFormat(): PricingFormat {
	return pricingFormat(useOptionalI18n()?.locale);
}

const emphasizeAmount = (content: ReactNode) => (
	<span className="font-heading tabular-nums">{content}</span>
);

/**
 * A plan's monthly AI allowance as one whole sentence, so the "/month" suffix
 * is translated with the amount instead of trailing it in English:
 * "$14/month AI usage included" (personal plans) or "$50/month shared AI
 * credits" (organization plans).
 */
export function MonthlyAiAllowance({
	amountUsd,
	shared = false,
}: {
	amountUsd: number;
	shared?: boolean;
}) {
	const tlRich = useRichLiteralMessages();
	const amount = usePricingFormat().price(amountUsd);
	const tags = { amount: emphasizeAmount };
	return (
		<span>
			{shared
				? tlRich(
						"<amount>{amount}</amount>/month shared AI credits",
						{ amount },
						tags
					)
				: tlRich(
						"<amount>{amount}</amount>/month AI usage included",
						{ amount },
						tags
					)}
		</span>
	);
}
