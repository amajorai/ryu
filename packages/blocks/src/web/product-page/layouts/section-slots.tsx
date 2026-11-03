import type { ReactNode } from "react";
import { HeroBackground } from "../../backgrounds/hero-background.tsx";
import { isStageProductSlug } from "../../backgrounds/stage-routes.ts";
import type { Product } from "../../data/products.tsx";
import FAQ from "../../faq.tsx";
import { withBentoFigures } from "../../iso/figures/bento/with-bento-figures.tsx";
import { landingSectionClass } from "../../landing-typography.ts";
import { ProductFigureSection, StageFigure } from "../../product-figure.tsx";
import { PRODUCT_FIGURE_BY_SLUG } from "../../product-figure-by-slug.ts";
import {
	BentoGrid,
	FeatureSplitRow,
	ProductCta,
	ProductHero,
	SectionHeading,
} from "../../sections.tsx";
import { StandaloneProductPricingSection } from "../../standalone-product-pricing.tsx";
import { figureFollowsHero } from "../archetypes.ts";
import {
	ProductBuiltFor,
	ProductHowItWorks,
	ProductStatement,
	ProductWorksWith,
} from "../explainer-sections.tsx";
import { getProductExplainer } from "../explainers.ts";
import type {
	ProductArchetypeId,
	ProductProfile,
	ProductSectionKey,
} from "../profile-types.ts";
import { hasPublishedPricing } from "../published-pricing.ts";
import { ProductAtAGlance } from "../sections/at-a-glance.tsx";
import { ProductFeatureExplorer } from "../sections/feature-explorer.tsx";
import { ProductIntegrationGrid } from "../sections/integration-grid.tsx";
import type { ArchetypeTheme } from "./archetype-theme.ts";
import { profileSlots } from "./profile-slots.tsx";

export interface SlotContext {
	readonly archetype: ProductArchetypeId;
	/** Display names for comparison slugs (the data lives in apps/web). */
	readonly compareNames?: Readonly<Record<string, string>>;
	readonly product: Product;
	readonly profile?: ProductProfile;
	readonly theme: ArchetypeTheme;
}

/** What each section key renders for one product; null means "skip". */
export type SectionSlots = Readonly<
	Record<ProductSectionKey, ReactNode | null>
>;

/** Archetypes whose quickstart replaces the explainer's three steps. */
const QUICKSTART_REPLACES_STEPS: readonly ProductArchetypeId[] = [
	"agent-api",
	"builder",
];

function heroSlot(product: Product): ReactNode {
	const stage = isStageProductSlug(product.slug) ? product.slug : null;
	if (!stage) {
		return <ProductHero {...product.hero} />;
	}
	return (
		<ProductHero
			{...product.hero}
			background={<HeroBackground id={stage} />}
			visual={undefined}
		/>
	);
}

/**
 * The figure. Directly under the stage hero it keeps the stage spacing; later
 * in the body it is an ordinary section that takes the archetype's rhythm.
 */
function figureSlot(product: Product, followsHero: boolean): ReactNode {
	const stage = isStageProductSlug(product.slug) ? product.slug : null;
	const stageFigure = stage ? PRODUCT_FIGURE_BY_SLUG[stage] : undefined;
	if (!(stageFigure || product.figure)) {
		return null;
	}
	return (
		<>
			{stageFigure && followsHero ? <StageFigure figure={stageFigure} /> : null}
			{stageFigure && !followsHero ? (
				<ProductFigureSection figure={stageFigure} />
			) : null}
			{product.figure ? <ProductFigureSection figure={product.figure} /> : null}
		</>
	);
}

function featuresSlot(product: Product): ReactNode {
	if (!product.splits?.length) {
		return null;
	}
	return (
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
	);
}

function capabilitiesSlot(product: Product): ReactNode {
	if (!product.bento.items.length) {
		return null;
	}
	return (
		<section className={landingSectionClass} data-testid="product-capabilities">
			<SectionHeading
				subtitle={product.bento.subtitle}
				title={product.bento.title}
			/>
			<BentoGrid items={withBentoFigures(product.slug, product.bento.items)} />
		</section>
	);
}

/**
 * Every slot for one product. Authored catalog and explainer content fills
 * the shared keys; ./profile-slots.tsx fills the profile-driven ones. Rules:
 * - `how-it-works` is null on API and builder pages that have a quickstart;
 * - `explorer` renders the feature rows, so only the workspace order lists it;
 * - `works-with` and `integrations` render the same explainer list two ways;
 * - `pricing` needs a standalone product with published pricing.
 */
export function buildSectionSlots(context: SlotContext): SectionSlots {
	const { archetype, product, profile, theme } = context;
	const explainer = getProductExplainer(product.slug);
	const faqItems = product.faq?.map((item, index) => ({
		id: `${product.slug}-faq-${index}`,
		title: item.question,
		content: item.answer,
	}));
	const quickstartReplacesSteps =
		QUICKSTART_REPLACES_STEPS.includes(archetype) &&
		Boolean(profile?.quickstart?.length);
	const worksWith = explainer.worksWith ?? [];

	return {
		...profileSlots(context),
		hero: heroSlot(product),
		figure: figureSlot(product, figureFollowsHero(archetype)),
		statement: explainer.statement ? (
			<ProductStatement statement={explainer.statement} />
		) : null,
		"at-a-glance": (
			<ProductAtAGlance
				columns={theme.atAGlance.columns}
				layout={theme.atAGlance.layout}
				product={product}
				profile={profile}
			/>
		),
		features: featuresSlot(product),
		explorer: <ProductFeatureExplorer product={product} />,
		"how-it-works":
			explainer.steps && !quickstartReplacesSteps ? (
				<ProductHowItWorks
					steps={explainer.steps}
					title={explainer.stepsTitle}
				/>
			) : null,
		capabilities: capabilitiesSlot(product),
		"built-for": explainer.builtFor?.length ? (
			<ProductBuiltFor audiences={explainer.builtFor} />
		) : null,
		pricing:
			product.standalone && hasPublishedPricing(product.slug) ? (
				<StandaloneProductPricingSection slug={product.slug} />
			) : null,
		faq: faqItems?.length ? <FAQ items={faqItems} /> : null,
		"works-with": worksWith.length ? (
			<ProductWorksWith slugs={worksWith} />
		) : null,
		integrations: worksWith.length ? (
			<ProductIntegrationGrid slugs={worksWith} />
		) : null,
		cta: <ProductCta {...product.cta} />,
	};
}
