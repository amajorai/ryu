import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import type { Product } from "../../data/products.tsx";
import { landingVisualFrameClass } from "../../landing-card-tones.ts";
import { type FeatureSplit, TextLink } from "../../sections.tsx";
import { FeatureExplorerTabs } from "./feature-explorer-tabs.tsx";
import {
	ProductSection,
	ProductSectionHeader,
	sectionBodyClass,
} from "./section-shell.tsx";

interface ExplorerEntry {
	readonly feature: FeatureSplit;
	readonly id: string;
	readonly label: string;
}

/**
 * The explorer's tabs: an Overview built from the tagline and the product's
 * own app visual, then one tab per feature row. On stage pages the hero shows
 * no visual (the Anatomy figure replaces it), so this is where a workspace's
 * app screen appears, beside the figure rather than instead of it.
 */
export function explorerEntries(product: Product): ExplorerEntry[] {
	const overview: ExplorerEntry = {
		id: "overview",
		label: "Overview",
		feature: {
			title: product.name,
			description: product.tagline,
			visual: product.hero.visual,
		},
	};
	const splits = (product.splits ?? []).map((split, index) => ({
		id: `feature-${index + 1}`,
		label: split.title,
		feature: split,
	}));
	return [overview, ...splits];
}

function ExplorerPanel({ feature }: { feature: FeatureSplit }): ReactNode {
	return (
		<div className="grid gap-8">
			{feature.visual ? (
				// The mock repeats the panel's claim in picture form, so screen
				// readers skip it; the heading and description carry the words.
				<div
					aria-hidden="true"
					className={cn(
						landingVisualFrameClass,
						"flex min-h-72 items-center justify-center rounded-3xl bg-muted/50 p-6 md:min-h-96 md:p-12 [&>*]:w-full [&>[data-minimal-card]]:bg-background"
					)}
					data-product-visual
				>
					{feature.visual}
				</div>
			) : null}
			<div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-12">
				<h3 className="text-balance font-heading font-medium text-2xl text-foreground leading-tight tracking-tight md:text-3xl">
					{feature.title}
				</h3>
				<div className="min-w-0">
					<p className={sectionBodyClass}>{feature.description}</p>
					{feature.bullets?.length ? (
						<ul className="mt-4 space-y-2">
							{feature.bullets.map((bullet) => (
								<li
									className="flex items-start gap-2.5 text-foreground text-sm"
									key={bullet}
								>
									<span
										aria-hidden="true"
										className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground"
									/>
									{bullet}
								</li>
							))}
						</ul>
					) : null}
					{feature.cta ? <TextLink cta={feature.cta} /> : null}
				</div>
			</div>
		</div>
	);
}

/**
 * Workspace pages lead with the product itself: a tabbed explorer whose
 * panels hold the app visual and each feature row. It renders the feature
 * rows, so the page carries the `product-features` marker inside it.
 */
export function ProductFeatureExplorer({ product }: { product: Product }) {
	const entries = explorerEntries(product);
	return (
		<ProductSection testId="product-feature-explorer">
			<ProductSectionHeader kicker="Explore" title="A closer look" />
			<div data-testid="product-features">
				<FeatureExplorerTabs
					groupId={`${product.slug}-explorer`}
					panels={entries.map((entry) => (
						<ExplorerPanel feature={entry.feature} key={entry.id} />
					))}
					tabs={entries.map(({ id, label }) => ({ id, label }))}
				/>
			</div>
		</ProductSection>
	);
}
