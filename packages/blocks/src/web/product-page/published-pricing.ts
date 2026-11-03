import { getStandaloneProductPricing } from "../data/standalone-pricing.ts";

const UNPUBLISHED_PRICE = /\bnot (?:yet )?(?:published|available)\b/i;

/**
 * An early-access product without a published price would get a pricing section
 * that only restates its unavailability, which the bento already says.
 *
 * Lives here (not in product-landing-page.tsx, which re-exports it) so the
 * archetype slots and base facts can use it without an import cycle.
 */
export function hasPublishedPricing(slug: string): boolean {
	const entry = getStandaloneProductPricing(slug);
	return Boolean(
		entry &&
			!(entry.status === "Early access" && UNPUBLISHED_PRICE.test(entry.price))
	);
}
