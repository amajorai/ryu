import { landingSectionClass } from "../landing-typography.ts";
import { ProductSectionHeader } from "../product-page/sections/section-shell.tsx";
import {
	categoryId,
	productsIndexGroups,
	productsIndexSummary,
} from "./products-index-data.ts";
import { ProductsIndexStart } from "./products-index-start.tsx";
import { ProductsIndexSummary } from "./products-index-summary.tsx";
import { ProductsIndexTable } from "./products-index-table.tsx";
import { ProductsIndexTabs } from "./products-index-tabs.tsx";

/**
 * The /products index below the hero: the catalog counted, then every product
 * as a spec row (what it is, its release state, its published price and its
 * docs) grouped by category behind a category filter, then where to start.
 * Server-rendered; only the filter is a client leaf.
 */
export function ProductsIndex({
	hiddenSlugs = [],
}: {
	/**
	 * Product slugs the host has not rolled out (a standalone service whose
	 * rollout flag is off, an unlaunched product). They are left out of the
	 * rows and the counts; the product data itself is never edited to hide one.
	 */
	hiddenSlugs?: readonly string[];
}) {
	const groups = productsIndexGroups(hiddenSlugs);
	const summary = productsIndexSummary(groups);
	return (
		<>
			<ProductsIndexSummary summary={summary} />
			<section
				className={landingSectionClass}
				data-testid="products-index-table"
			>
				<ProductSectionHeader
					size="small"
					subtitle="What each product is, whether you can use it today, what it costs where the price is published, and where its docs live."
					title="Every product, side by side"
				/>
				<ProductsIndexTabs
					tabs={groups.map((group) => {
						const id = categoryId(group.category);
						return {
							count: group.rows.length,
							id,
							label: group.category,
							panel: (
								<ProductsIndexTable
									group={group}
									headingId={`products-index-${id}-title`}
								/>
							),
						};
					})}
				/>
				<ProductsIndexStart />
			</section>
		</>
	);
}
