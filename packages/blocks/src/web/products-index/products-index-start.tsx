import Link from "next/link";
import { LinkArrow } from "../link-arrow.tsx";
import { nextLinkHref } from "../next-link-href.ts";
import { sectionKickerClass } from "../product-page/sections/section-shell.tsx";

/**
 * Where a first-time visitor goes next. Each line restates the destination
 * page's own metadata description (platform, pricing and compare pages).
 */
export const PRODUCTS_INDEX_START_LINKS = [
	{
		href: "/platform",
		label: "How it fits together",
		description:
			"The runtime, gateway, and SDKs to run agents in your own product.",
	},
	{
		href: "/pricing",
		label: "Pricing",
		description:
			"Subscription plans, credit fees, standalone product rates, and managed cloud add-ons.",
	},
	{
		href: "/compare",
		label: "Compare",
		description:
			"Agent runtimes, frameworks, and hosted assistants, side by side with primary references.",
	},
] as const;

/** A three-link row under the index: architecture, pricing, comparisons. */
export function ProductsIndexStart() {
	return (
		<nav
			aria-labelledby="products-index-start-title"
			className="mt-16 border-border border-t pt-10 md:mt-20"
			data-testid="products-index-start"
		>
			<h2 className={sectionKickerClass} id="products-index-start-title">
				Where to start
			</h2>
			<ul className="mt-6 grid gap-8 sm:grid-cols-3">
				{PRODUCTS_INDEX_START_LINKS.map((link) => (
					<li key={link.href}>
						<Link
							className="group block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							href={nextLinkHref(link.href)}
						>
							<span className="font-heading font-medium text-base text-foreground underline-offset-4 group-hover:underline">
								{link.label}
							</span>
							<LinkArrow className="ms-1 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
							<span className="mt-1.5 block text-pretty text-muted-foreground text-sm leading-relaxed">
								{link.description}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}
