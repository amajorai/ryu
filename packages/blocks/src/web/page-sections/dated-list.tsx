import Link from "next/link";
import type { ReactNode } from "react";
import { LinkArrow } from "../link-arrow.tsx";
import { nextLinkHref } from "../next-link-href.ts";
import { isIsoDate } from "./format-date.ts";
import { IsoDateText } from "./iso-date-text.tsx";

/**
 * One row of a dated list. `date` is an ISO date ("2026-04-12" or "2026-04"),
 * rendered in a `<time dateTime>`; `tag` is a short label (a level, a format,
 * a category); `meta` is a quiet second line (outlet, location).
 */
export interface DatedListItem {
	readonly date?: string;
	readonly external?: boolean;
	readonly href: string;
	readonly id: string;
	readonly meta?: string;
	readonly tag?: string;
	readonly title: string;
}

const rowClass =
	"group grid gap-1.5 py-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[8rem_1fr_auto] sm:items-baseline sm:gap-8";

function RowLink({
	item,
	children,
}: {
	item: DatedListItem;
	children: ReactNode;
}) {
	if (item.external) {
		return (
			<a
				className={rowClass}
				href={item.href}
				rel="noopener noreferrer"
				target="_blank"
			>
				{children}
			</a>
		);
	}
	return (
		<Link className={rowClass} href={nextLinkHref(item.href)}>
			{children}
		</Link>
	);
}

/**
 * A ruled, newest-first list of dated entries (announcements, events, roles):
 * date, title with an optional meta line, then an optional tag. The order is
 * the caller's; the list does no date math, so prerendered output stays
 * deterministic. With no items it renders `emptyState` in the list's place.
 */
export function DatedList({
	items,
	emptyState,
	title,
	headingLevel: Heading = "h3",
	testId,
	className,
}: {
	items: readonly DatedListItem[];
	emptyState: ReactNode;
	title?: string;
	headingLevel?: "h2" | "h3";
	testId?: string;
	className?: string;
}) {
	return (
		<div className={className} data-count={items.length} data-testid={testId}>
			{title ? (
				<Heading className="mb-6 font-heading font-medium text-foreground text-lg tracking-tight">
					{title}
				</Heading>
			) : null}
			{items.length === 0 ? (
				emptyState
			) : (
				<ul className="border-border border-t">
					{items.map((item) => (
						<li className="border-border border-b" key={item.id}>
							<RowLink item={item}>
								<span className="text-muted-foreground text-sm tabular-nums">
									{item.date && isIsoDate(item.date) ? (
										<IsoDateText value={item.date} />
									) : null}
								</span>
								<span className="min-w-0">
									<span className="block text-pretty font-heading font-medium text-base text-foreground">
										{item.title}
										{item.external ? (
											<span className="sr-only"> (opens in a new tab)</span>
										) : null}
									</span>
									{item.meta ? (
										<span className="mt-1 block text-muted-foreground text-sm">
											{item.meta}
										</span>
									) : null}
								</span>
								<span className="flex items-center gap-3">
									{item.tag ? (
										<span className="rounded-full border border-border px-2.5 py-0.5 text-muted-foreground text-xs">
											{item.tag}
										</span>
									) : null}
									<LinkArrow className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground sm:inline-block group-hover:rtl:-translate-x-0.5" />
								</span>
							</RowLink>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
