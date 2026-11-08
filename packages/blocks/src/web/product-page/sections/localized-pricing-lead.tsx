"use client";

import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { getStandaloneProductPricing } from "../../data/standalone-pricing.ts";
import {
	FactSheet,
	type FactSheetColumns,
	type FactSheetFact,
} from "../../page-sections/fact-sheet.tsx";

/** The label of the base pricing fact (`productBaseFacts`). */
const PRICING_LABEL = "Pricing";

/**
 * A product's published price lead in the reader's language and number
 * format. The server renders the English row (the /products index and the
 * "At a glance" sheet are static pages); the DOM localizer can translate that
 * sentence's template but keeps its captured English figures ("$0.025",
 * "10,000"), so the lead is rebuilt here from the typed pricing data.
 * `fallback` is the server's English lead, kept for an unknown slug.
 */
export function useLocalizedPricingLead(
	slug: string,
	fallback: string
): string {
	const tl = useLiteralMessages();
	const formatLocale = useOptionalI18n()?.formatLocale;
	const entry = getStandaloneProductPricing(slug, tl, formatLocale);
	return entry ? (entry.lead ?? entry.price) : fallback;
}

/** The price lead as text, for the /products index's pricing cell. */
export function LocalizedPricingLead({
	slug,
	fallback,
}: {
	slug: string;
	fallback: string;
}) {
	return useLocalizedPricingLead(slug, fallback);
}

/**
 * The "At a glance" fact sheet with its Pricing value formatted for the
 * reader's locale. Every other fact passes through unchanged.
 */
export function LocalizedFactSheet({
	slug,
	facts,
	title,
	columns,
	className,
}: {
	slug: string;
	facts: readonly FactSheetFact[];
	title?: string;
	columns?: FactSheetColumns;
	className?: string;
}) {
	const pricing = facts.find((fact) => fact.label === PRICING_LABEL);
	const lead = useLocalizedPricingLead(slug, pricing?.value ?? "");
	const localized = pricing
		? facts.map((fact) =>
				fact.label === PRICING_LABEL ? { ...fact, value: lead } : fact
			)
		: facts;
	return (
		<FactSheet
			className={className}
			columns={columns}
			facts={localized}
			title={title}
		/>
	);
}
