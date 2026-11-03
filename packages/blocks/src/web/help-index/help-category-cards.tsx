import { formatMessage } from "@ryu/i18n/core";
import { cn } from "@ryu/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { LinkArrow } from "../link-arrow.tsx";
import {
	sectionChipClass,
	sectionItemTitleClass,
	sectionSurfaceClass,
} from "../product-page/sections/section-shell.tsx";
import {
	HELP_TOPICS_SECTION,
	helpCategoryDescription,
	helpCategoryHref,
} from "./help-index-content.ts";

// The /help topic rail: one card per category, each naming how many articles
// it holds and linking to that category's page. Server-safe (no hooks); copy is
// plain English for the DOM localizer, plurals formatted through the catalog.

export interface HelpCategoryCount {
	count: number;
	name: string;
}

/**
 * Articles per category, in the order of `categories`. A category with no
 * article is left out, so a card never links to an empty page.
 */
export function countHelpArticlesByCategory(
	articles: readonly { category: string }[],
	categories: readonly string[]
): HelpCategoryCount[] {
	const counts = new Map<string, number>();
	for (const article of articles) {
		counts.set(article.category, (counts.get(article.category) ?? 0) + 1);
	}
	const rows: HelpCategoryCount[] = [];
	for (const name of categories) {
		const count = counts.get(name) ?? 0;
		if (count > 0) {
			rows.push({ name, count });
		}
	}
	return rows;
}

export function helpArticleCountLabel(count: number): string {
	return formatMessage(
		"{count, plural, one {# article} other {# articles}}",
		{ count },
		"en"
	);
}

const focusRingClass =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The category cards, headed for the page outline; nothing when empty. */
export function HelpCategoryCards({
	categories,
	className,
}: {
	categories: readonly HelpCategoryCount[];
	className?: string;
}) {
	if (categories.length === 0) {
		return null;
	}
	const headingId = `${HELP_TOPICS_SECTION.id}-heading`;
	return (
		<nav
			aria-labelledby={headingId}
			className={className}
			data-testid="help-topics"
		>
			<h2
				className="mb-4 font-medium text-muted-foreground text-sm"
				id={headingId}
			>
				{HELP_TOPICS_SECTION.title}
			</h2>
			<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
				{categories.map((category) => {
					const description = helpCategoryDescription(category.name);
					return (
						<li data-help-category={category.name} key={category.name}>
							<Link
								className={cn(
									sectionSurfaceClass,
									"group flex h-full flex-col gap-2 p-5 transition-colors hover:bg-muted",
									focusRingClass
								)}
								href={helpCategoryHref(category.name) as Route}
							>
								<span className="flex items-center justify-between gap-3">
									<span
										className={cn(
											sectionItemTitleClass,
											"underline-offset-4 group-hover:underline"
										)}
									>
										{category.name}
									</span>
									<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
								</span>
								{description ? (
									<span className="text-pretty text-muted-foreground text-sm leading-relaxed">
										{description}
									</span>
								) : null}
								<span className={cn(sectionChipClass, "mt-1 w-fit")}>
									{helpArticleCountLabel(category.count)}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
