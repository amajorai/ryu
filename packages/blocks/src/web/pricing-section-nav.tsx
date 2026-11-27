"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";

/**
 * The pricing page's sections below the plan cards. Each value is the `id`
 * its section component sets on itself, so a link here always has a target.
 */
export const PRICING_SECTION_IDS = {
	compare: "compare-plans",
	credits: "what-credits-buy",
	fees: "fees",
	products: "standalone-pricing",
	questions: "pricing-faq",
} as const;

export type PricingSectionKey = keyof typeof PRICING_SECTION_IDS;

/**
 * "On this page": a quiet row of anchor links under the plan cards, so a
 * buyer can jump to the comparison, the credit estimates, the fees, the other
 * products, or the questions without scrolling the whole page. Plain links to
 * section ids: it works without JavaScript, and on a phone the row scrolls
 * sideways inside its own pill instead of wrapping into a block.
 */
export function PricingSectionNav({
	className,
	sections,
}: {
	className?: string;
	/** The sections on screen, in page order. */
	sections: readonly PricingSectionKey[];
}) {
	const tl = useLiteralMessages();
	const labels: Record<PricingSectionKey, string> = {
		compare: tl("Compare plans"),
		credits: tl("Credits"),
		fees: tl("Fees"),
		products: tl("Products"),
		questions: tl("Questions"),
	};
	if (sections.length === 0) {
		return null;
	}
	return (
		<nav
			aria-label={tl("On this page")}
			className={cn("flex justify-center", className)}
			data-testid="pricing-section-nav"
		>
			<ul className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-card p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{sections.map((section) => (
					<li className="shrink-0" key={section}>
						<a
							className="inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-3.5 font-medium text-muted-foreground text-sm transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
							data-pricing-section-link={section}
							href={`#${PRICING_SECTION_IDS[section]}`}
						>
							{labels[section]}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
