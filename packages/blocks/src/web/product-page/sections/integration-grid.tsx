import Link from "next/link";
import type { Product } from "../../data/products.tsx";
import { getProduct } from "../../data/products.tsx";
import { LinkArrow } from "../../link-arrow.tsx";
import { nextLinkHref } from "../../next-link-href.ts";
import { productHref } from "../../product-href.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionItemTitleClass,
} from "./section-shell.tsx";

/** Known products for the slugs, in order; unknown slugs are dropped. */
export function integrationProducts(slugs: readonly string[]): Product[] {
	return slugs.flatMap((slug) => {
		const product = getProduct(slug);
		return product ? [product] : [];
	});
}

/**
 * "Works with" as cards: the related product's icon, name and tagline. Used
 * by the API, builder and workspace pages, where the neighbours are things
 * you wire together; platform pages keep the quieter ruled rows.
 */
export function ProductIntegrationGrid({
	slugs,
}: {
	slugs: readonly string[];
}) {
	const related = integrationProducts(slugs);
	if (related.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-integrations">
			<ProductSectionHeader size="small" title="Works with" />
			<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{related.map((product) => (
					<li className="min-w-0" key={product.slug}>
						<Link
							className="group flex h-full min-w-0 items-start gap-4 rounded-2xl bg-muted/50 p-5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							data-product-card=""
							href={nextLinkHref(productHref(product))}
						>
							<span
								aria-hidden="true"
								className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-foreground"
							>
								<product.Icon className="size-5" />
							</span>
							<span className="min-w-0 flex-1">
								<span className={`block ${sectionItemTitleClass}`}>
									{product.name}
								</span>
								<span className="mt-1 block text-pretty text-muted-foreground text-sm leading-relaxed">
									{product.tagline}
								</span>
							</span>
							<LinkArrow className="mt-1 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground group-hover:rtl:-translate-x-0.5" />
						</Link>
					</li>
				))}
			</ul>
		</ProductSection>
	);
}
