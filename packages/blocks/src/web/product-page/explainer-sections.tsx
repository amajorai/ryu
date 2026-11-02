import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { getProduct } from "../data/products.tsx";
import { landingSectionClass } from "../landing-typography.ts";
import { LinkArrow } from "../link-arrow.tsx";
import { nextLinkHref } from "../next-link-href.ts";
import { productHref } from "../product-href.ts";
import { NumberedSteps, SectionHeading } from "../sections.tsx";
import type { ProductAudience, ProductExplainer } from "./explainer-types.ts";

// The statement translates its whole paragraph at render, so it is a client
// component of its own; re-exported to keep this module the sections' entry.
export { ProductStatement } from "./product-statement.tsx";

// The explainer sections a product page carries around its capabilities, each
// rendered only when the product's explainer sets it (see ./explainers.ts).

const itemTitleClass = "font-heading font-medium text-base text-foreground";
const itemDescriptionClass =
	"text-muted-foreground text-[15px] leading-relaxed";

export function ProductHowItWorks({
	steps,
	title = "How it works",
}: {
	steps: NonNullable<ProductExplainer["steps"]>;
	title?: string;
}) {
	return (
		<section className={landingSectionClass} data-testid="product-how-it-works">
			<SectionHeading title={title} />
			<NumberedSteps steps={[...steps]} />
		</section>
	);
}

export function ProductBuiltFor({
	audiences,
}: {
	audiences: readonly ProductAudience[];
}) {
	return (
		<section className={landingSectionClass} data-testid="product-built-for">
			<SectionHeading title="Built for" />
			<ul
				className={cn(
					"grid gap-x-12 gap-y-10 border-border border-t pt-10 sm:grid-cols-2",
					audiences.length >= 3 && "lg:grid-cols-3"
				)}
			>
				{audiences.map((audience) => (
					<li key={audience.title}>
						<h3 className={itemTitleClass}>{audience.title}</h3>
						<p className={cn("mt-2", itemDescriptionClass)}>
							{audience.description}
						</p>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Related products as quiet ruled rows: name, tagline, arrow. */
export function ProductWorksWith({ slugs }: { slugs: readonly string[] }) {
	const related = slugs.flatMap((slug) => {
		const product = getProduct(slug);
		return product ? [product] : [];
	});
	if (related.length === 0) {
		return null;
	}
	return (
		<section className={landingSectionClass} data-testid="product-works-with">
			<SectionHeading title="Works with" />
			<ul className="border-border border-t">
				{related.map((product) => (
					<li className="border-border border-b" key={product.slug}>
						<Link
							className="group grid gap-1 py-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[12rem_1fr_auto] sm:items-baseline sm:gap-8"
							data-cuelume-hover="tick"
							href={nextLinkHref(productHref(product))}
						>
							<span className={itemTitleClass}>{product.name}</span>
							<span className={itemDescriptionClass}>{product.tagline}</span>
							<LinkArrow className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:inline-block group-hover:rtl:-translate-x-0.5" />
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
