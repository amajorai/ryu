import { HeroBackground } from "./backgrounds/hero-background.tsx";
import { isStageProductSlug } from "./backgrounds/stage-routes.ts";
import type { Product } from "./data/products.tsx";
import { getStandaloneProductPricing } from "./data/standalone-pricing.ts";
import FAQ from "./faq.tsx";
import { withBentoFigures } from "./iso/figures/bento/with-bento-figures.tsx";
import { landingSectionClass } from "./landing-typography.ts";
import { ProductFigureSection, StageFigure } from "./product-figure.tsx";
import { PRODUCT_FIGURE_BY_SLUG } from "./product-figure-by-slug.ts";
import {
	ProductBuiltFor,
	ProductHowItWorks,
	ProductStatement,
	ProductWorksWith,
} from "./product-page/explainer-sections.tsx";
import { getProductExplainer } from "./product-page/explainers.ts";
import {
	BentoGrid,
	FeatureSplitRow,
	ProductCta,
	ProductHero,
	SectionHeading,
} from "./sections.tsx";
import { StandaloneProductPricingSection } from "./standalone-product-pricing.tsx";

const UNPUBLISHED_PRICE = /\bnot (?:yet )?(?:published|available)\b/i;

/**
 * An early-access product without a published price would get a pricing section
 * that only restates its unavailability, which the bento already says.
 */
export function hasPublishedPricing(slug: string): boolean {
	const entry = getStandaloneProductPricing(slug);
	return Boolean(
		entry &&
			!(entry.status === "Early access" && UNPUBLISHED_PRICE.test(entry.price))
	);
}

/**
 * Shared product-page body used by the catalog and the public surface aliases.
 * Order: hero → figure → what it is → feature rows → how it works → capabilities
 * → built for → pricing → FAQ → works with → closing CTA. The explainer sections
 * (./product-page/) render only for products whose explainer sets them.
 *
 * A product with a backdrop opens on a full-viewport stage hero, followed by its
 * Anatomy figure bare on the page in place of the hero visual.
 */
export default function ProductLandingPage({ product }: { product: Product }) {
	const faqItems = product.faq?.map((item, index) => ({
		id: `${product.slug}-faq-${index}`,
		title: item.q,
		content: item.a,
	}));

	const explainer = getProductExplainer(product.slug);
	const stage = isStageProductSlug(product.slug) ? product.slug : null;
	const stageFigure = stage ? PRODUCT_FIGURE_BY_SLUG[stage] : undefined;

	return (
		<div data-testid={`product-page-${product.slug}`}>
			{stage ? (
				<>
					<ProductHero
						{...product.hero}
						background={<HeroBackground id={stage} />}
						visual={undefined}
					/>
					{stageFigure ? <StageFigure figure={stageFigure} /> : null}
				</>
			) : (
				<ProductHero {...product.hero} />
			)}

			{product.figure ? <ProductFigureSection figure={product.figure} /> : null}

			{explainer.statement ? (
				<ProductStatement statement={explainer.statement} />
			) : null}

			{product.splits?.length ? (
				<section className={landingSectionClass} data-testid="product-features">
					<div className="space-y-28 md:space-y-40">
						{product.splits.map((split, index) => (
							<FeatureSplitRow
								feature={split}
								headingLevel="h2"
								index={index}
								key={split.title}
							/>
						))}
					</div>
				</section>
			) : null}

			{explainer.steps ? (
				<ProductHowItWorks
					steps={explainer.steps}
					title={explainer.stepsTitle}
				/>
			) : null}

			{product.bento.items.length ? (
				<section
					className={landingSectionClass}
					data-testid="product-capabilities"
				>
					<SectionHeading
						subtitle={product.bento.subtitle}
						title={product.bento.title}
					/>
					<BentoGrid
						items={withBentoFigures(product.slug, product.bento.items)}
					/>
				</section>
			) : null}

			{explainer.builtFor?.length ? (
				<ProductBuiltFor audiences={explainer.builtFor} />
			) : null}

			{product.standalone && hasPublishedPricing(product.slug) ? (
				<StandaloneProductPricingSection slug={product.slug} />
			) : null}

			{faqItems?.length ? <FAQ items={faqItems} /> : null}

			{explainer.worksWith?.length ? (
				<ProductWorksWith slugs={explainer.worksWith} />
			) : null}

			<ProductCta {...product.cta} />
		</div>
	);
}
