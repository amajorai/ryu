import type { Product } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import { getStandaloneProductPricing } from "../data/standalone-pricing.ts";
import { PRODUCT_SECTION_NAV } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import type { ProductFactRow } from "./profile-types.ts";
import { hasPublishedPricing } from "./published-pricing.ts";

const AVAILABILITY_LABELS = {
	"early-access": "Early access",
	"coming-soon": "Coming soon",
} as const;

/** "Generally available", "Early access" or "Coming soon". */
export function productAvailabilityLabel(product: Product): string {
	return product.status
		? AVAILABILITY_LABELS[product.status]
		: "Generally available";
}

/** The first sentence of a pricing string, for a one-line fact. */
function leadSentence(text: string): string {
	const match = text.match(/^(.+?[.!?])(?:\s|$)/s);
	return (match?.[1] ?? text).trim();
}

/**
 * Facts every product page can state from typed catalog and pricing data, so
 * the "At a glance" sheet exists before a profile is written. They are not
 * grounded by quote (they are the typed source themselves):
 * - Availability: the catalog status;
 * - Category: the catalog category;
 * - Pricing: the first sentence of the published standalone price, linked to
 *   the pricing section, only when `hasPublishedPricing`;
 * - Docs: the "Read the docs" CTA's path, when the product has one.
 */
export function productBaseFacts(product: Product): ProductFactRow[] {
	const facts: ProductFactRow[] = [
		{ label: "Availability", value: productAvailabilityLabel(product) },
		{ label: "Category", value: product.category },
	];
	const pricing = getStandaloneProductPricing(product.slug);
	if (product.standalone && pricing && hasPublishedPricing(product.slug)) {
		facts.push({
			label: "Pricing",
			value: leadSentence(pricing.price),
			href: `#${PRODUCT_SECTION_NAV.pricing?.id ?? "pricing"}`,
		});
	}
	const docsPath = productDocsPath(product);
	if (docsPath) {
		facts.push({
			label: "Docs",
			value: docsPath,
			href: docsHref(docsPath),
			external: true,
		});
	}
	return facts;
}
