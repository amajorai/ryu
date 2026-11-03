import Link from "next/link";
import { LinkArrow } from "../../link-arrow.tsx";
import { nextLinkHref } from "../../next-link-href.ts";
import { ProductSection, ProductSectionHeader } from "./section-shell.tsx";

/** The comparison page for a slug of apps/web/src/data/comparisons/<slug>.json. */
export function compareHref(slug: string): string {
	return `/compare/${slug}`;
}

/**
 * Links to the comparison pages that cover this product. The comparison data
 * lives in apps/web, so the display names come from the caller (`names`);
 * without one the slug is shown as written, never a guessed brand name.
 */
export function ProductCompareLinks({
	slugs,
	names = {},
}: {
	slugs: readonly string[];
	names?: Readonly<Record<string, string>>;
}) {
	if (slugs.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-compare">
			<ProductSectionHeader size="small" title="How it compares" />
			<ul className="flex flex-wrap gap-2">
				{slugs.map((slug) => {
					const name = names[slug];
					return (
						<li key={slug}>
							<Link
								className="group inline-flex min-h-10 items-center gap-2 rounded-full bg-muted/60 px-4 text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
								href={nextLinkHref(compareHref(slug))}
							>
								<span className="text-muted-foreground">Ryu vs</span>
								{name ? (
									<span className="font-medium">{name}</span>
								) : (
									<span className="font-mono">{slug}</span>
								)}
								<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
							</Link>
						</li>
					);
				})}
			</ul>
		</ProductSection>
	);
}
