import type { Product } from "../data/products.tsx";
import { docsHref } from "../data/resources.tsx";
import type { CtaLink } from "../sections.tsx";

/**
 * The docs-site path ("/docs/standalone/box") behind a product's "Read the
 * docs" CTA, primary or secondary, hero first; undefined when it has none.
 * Catalog CTAs are absolute (`readTheDocs` in ../data/catalog/shared.tsx), so
 * the path is recovered by stripping the docs origin.
 */
export function productDocsPath(product: Product): string | undefined {
	const docsOrigin = docsHref("/");
	const ctas: (CtaLink | undefined)[] = [
		product.hero.primaryCta,
		product.hero.secondaryCta,
		product.cta.primaryCta,
		product.cta.secondaryCta,
	];
	for (const cta of ctas) {
		if (cta?.external && cta.href.startsWith(docsOrigin)) {
			return `/${cta.href.slice(docsOrigin.length)}`.replace(/\/$/, "") || "/";
		}
	}
	return undefined;
}
