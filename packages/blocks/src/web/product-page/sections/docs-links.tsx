import { docsHref } from "../../data/resources.tsx";
import { LinkArrow } from "../../link-arrow.tsx";
import type { ProductDocLink } from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionItemTitleClass,
} from "./section-shell.tsx";

/**
 * Docs pages for the product, by docs-site path. The docs live on their own
 * site, so every link is absolute (`docsHref`) and opens in a new tab; the
 * path is shown in mono so the reader knows where they will land.
 */
export function ProductDocsLinks({
	links,
	title = "Read the docs",
}: {
	links: readonly ProductDocLink[];
	title?: string;
}) {
	if (links.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-docs">
			<ProductSectionHeader kicker="Docs" size="small" title={title} />
			<ul className="grid grid-cols-1 gap-x-10 border-border border-t md:grid-cols-2">
				{links.map((link) => (
					<li className="min-w-0 border-border border-b" key={link.path}>
						<a
							className="group flex min-h-16 items-start justify-between gap-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
							href={docsHref(link.path)}
							rel="noopener noreferrer"
							target="_blank"
						>
							<span className="min-w-0">
								<span className={`block ${sectionItemTitleClass}`}>
									{link.label}
								</span>
								{link.description ? (
									<span className="mt-1 block text-pretty text-muted-foreground text-sm leading-relaxed">
										{link.description}
									</span>
								) : null}
								<span className="mt-2 block truncate font-mono text-muted-foreground text-xs">
									{link.path}
								</span>
							</span>
							<LinkArrow className="mt-1 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground group-hover:rtl:-translate-x-0.5" />
						</a>
					</li>
				))}
			</ul>
		</ProductSection>
	);
}
