import type { Product } from "./data/products.tsx";
import { ArchetypeLayout } from "./product-page/layouts/archetype-layout.tsx";

// Kept as a public export of this module: apps/web and tests import it from here.
export { hasPublishedPricing } from "./product-page/published-pricing.ts";

/**
 * Shared product-page body used by the catalog and the public surface aliases.
 *
 * Every product keeps the same opening: a stage hero (full-viewport, over an
 * animated backdrop) followed by its Anatomy figure, or the showcase hero for
 * a product without a backdrop. Below that the page takes its archetype's
 * composition (./product-page/archetypes.ts): infrastructure reads like a
 * datasheet, agent APIs like a developer reference, builder tools open on
 * code, workspaces on a tabbed explorer, catalogs on a directory, previews on
 * a status board. ./product-page/layouts/ holds the order, rhythm and bands.
 *
 * `compareNames` labels the profile's comparison links; the comparison data
 * lives in apps/web, so the route may pass it.
 */
export default function ProductLandingPage({
	product,
	compareNames,
}: {
	product: Product;
	compareNames?: Readonly<Record<string, string>>;
}) {
	return (
		<div data-testid={`product-page-${product.slug}`}>
			<ArchetypeLayout compareNames={compareNames} product={product} />
		</div>
	);
}
