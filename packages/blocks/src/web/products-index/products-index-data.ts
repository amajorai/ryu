import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type Product,
	type ProductCategory,
	productCategories,
	productsByCategory,
} from "../data/products.tsx";
import { productHref } from "../product-href.ts";
import { productBaseFacts } from "../product-page/base-facts.ts";

/**
 * A product's release state, keyed for styling; the label is the visible text.
 * The catalog only marks products that are not yet open (`early-access`,
 * `coming-soon`). A product with no status is "available": usable today, with
 * no claim of general availability, since the catalog never states one and the
 * public docs still describe a waitlist beta.
 */
export type ProductsIndexAvailability =
	| "available"
	| "early-access"
	| "coming-soon";

/** The visible label of each release state. */
export const PRODUCTS_INDEX_AVAILABILITY_LABELS: Readonly<
	Record<ProductsIndexAvailability, string>
> = {
	available: "Available",
	"early-access": "Early access",
	"coming-soon": "Coming soon",
};

/** One spec row of the /products index. Every field comes from typed catalog data. */
export interface ProductsIndexRow {
	readonly availability: ProductsIndexAvailability;
	readonly category: ProductCategory;
	/** Absolute docs URL behind the product's "Read the docs" CTA, when it has one. */
	readonly docsHref?: string;
	readonly href: string;
	readonly name: string;
	/**
	 * The published standalone price's lead message; only set when the
	 * product page states that price (`productBaseFacts`, which checks
	 * `hasPublishedPricing`).
	 */
	readonly pricing?: string;
	readonly slug: string;
	/** "Available", "Early access" or "Coming soon". */
	readonly status: string;
	readonly tagline: string;
}

export interface ProductsIndexGroup {
	readonly category: ProductCategory;
	readonly rows: readonly ProductsIndexRow[];
}

export interface ProductsIndexSummary {
	readonly byAvailability: Readonly<Record<ProductsIndexAvailability, number>>;
	readonly byCategory: readonly {
		readonly category: ProductCategory;
		readonly count: number;
	}[];
	readonly total: number;
}

function availabilityOf(product: Product): ProductsIndexAvailability {
	return product.status ?? "available";
}

/**
 * A catalog product as an index row: status, the published price lead and
 * docs. `tl` and `locale` translate and format the price lead (English by
 * default; the client cell re-formats it for the reader).
 */
export function productsIndexRow(
	product: Product,
	tl?: LiteralMessage,
	locale?: string | null
): ProductsIndexRow {
	const facts = productBaseFacts(product, tl, locale);
	const availability = availabilityOf(product);
	const pricing = facts.find((fact) => fact.label === "Pricing");
	const docs = facts.find((fact) => fact.label === "Docs");
	return {
		availability,
		category: product.category,
		docsHref: docs?.href,
		href: productHref(product),
		name: product.name,
		pricing: pricing?.value,
		slug: product.slug,
		status: PRODUCTS_INDEX_AVAILABILITY_LABELS[availability],
		tagline: product.tagline,
	};
}

/**
 * The index rows grouped by category, in the catalog's canonical order. Slugs
 * the host has not rolled out are dropped, then any category left empty.
 */
export function productsIndexGroups(
	hiddenSlugs: readonly string[] = []
): ProductsIndexGroup[] {
	const hidden = new Set(hiddenSlugs);
	const groups: ProductsIndexGroup[] = [];
	for (const category of productCategories) {
		const rows = productsByCategory(category)
			.filter((product) => !hidden.has(product.slug))
			.map((product) => productsIndexRow(product));
		if (rows.length > 0) {
			groups.push({ category, rows });
		}
	}
	return groups;
}

/** Counts for the summary strip, computed from the rows shown. */
export function productsIndexSummary(
	groups: readonly ProductsIndexGroup[]
): ProductsIndexSummary {
	const byAvailability: Record<ProductsIndexAvailability, number> = {
		available: 0,
		"early-access": 0,
		"coming-soon": 0,
	};
	let total = 0;
	for (const group of groups) {
		for (const row of group.rows) {
			byAvailability[row.availability] += 1;
			total += 1;
		}
	}
	return {
		byAvailability,
		byCategory: groups.map((group) => ({
			category: group.category,
			count: group.rows.length,
		})),
		total,
	};
}

/** A stable DOM-safe id fragment for a category ("Agent APIs" -> "agent-apis"). */
export function categoryId(category: ProductCategory): string {
	return category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
