import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { LinkArrow } from "../link-arrow.tsx";
import { nextLinkHref } from "../next-link-href.ts";
import { ScrollRegion } from "../product-page/sections/scroll-region.tsx";
import { sectionChipClass } from "../product-page/sections/section-shell.tsx";
import type {
	ProductsIndexAvailability,
	ProductsIndexGroup,
	ProductsIndexRow,
} from "./products-index-data.ts";
import { ProductCount } from "./products-index-tabs.tsx";

/** English formatting for server-rendered copy; the client DOM localizer
 * translates the rendered sentence through its catalog template. */
const tl: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

/**
 * The chip's marker, echoing the status board: filled for available, outlined
 * for early access, dashed for coming soon. The chip's text always names the
 * state, so the marker is never the only cue.
 */
export const AVAILABILITY_MARKERS: Readonly<
	Record<ProductsIndexAvailability, string>
> = {
	available: "bg-foreground",
	"early-access": "border border-foreground",
	"coming-soon": "border border-muted-foreground border-dashed",
};

const textLinkClass =
	"rounded-sm underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const cellClass = "py-4 pe-6 align-top last:pe-0";

export function AvailabilityChip({ row }: { row: ProductsIndexRow }) {
	return (
		<span className={cn(sectionChipClass, "whitespace-nowrap")}>
			<span
				aria-hidden="true"
				className={cn(
					"size-2 shrink-0 rounded-full",
					AVAILABILITY_MARKERS[row.availability]
				)}
			/>
			{row.status}
		</span>
	);
}

function PricingCell({ row }: { row: ProductsIndexRow }) {
	if (row.pricing) {
		return <span className="text-pretty text-foreground">{row.pricing}</span>;
	}
	return (
		<Link
			aria-label={tl("See pricing for {name}", { name: row.name })}
			className={textLinkClass}
			href={nextLinkHref("/pricing")}
		>
			See pricing
		</Link>
	);
}

function DocsCell({ row }: { row: ProductsIndexRow }) {
	if (!row.docsHref) {
		return (
			<>
				<span aria-hidden="true">–</span>
				<span className="sr-only">No docs link</span>
			</>
		);
	}
	return (
		<a
			aria-label={tl("Docs for {name} (opens in a new tab)", {
				name: row.name,
			})}
			className={cn(textLinkClass, "whitespace-nowrap")}
			href={row.docsHref}
			rel="noopener noreferrer"
			target="_blank"
		>
			Docs
		</a>
	);
}

function ProductRow({ row }: { row: ProductsIndexRow }) {
	return (
		<tr className="border-border border-b" data-products-index-row={row.slug}>
			<th className={cn(cellClass, "font-normal")} scope="row">
				<Link
					className="group inline-flex items-baseline gap-1 rounded-sm font-heading font-medium text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					href={nextLinkHref(row.href)}
				>
					<span className="underline-offset-4 group-hover:underline">
						{row.name}
					</span>
					<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
				</Link>
			</th>
			<td className={cn(cellClass, "text-pretty text-muted-foreground")}>
				{row.tagline}
			</td>
			<td className={cellClass}>
				<AvailabilityChip row={row} />
			</td>
			<td className={cn(cellClass, "text-muted-foreground")}>
				<PricingCell row={row} />
			</td>
			<td className={cn(cellClass, "text-muted-foreground")}>
				<DocsCell row={row} />
			</td>
		</tr>
	);
}

const COLUMNS = [
	{ label: "Product", className: "w-44" },
	{ label: "What it is", className: "min-w-60" },
	{ label: "Status", className: "w-40" },
	{ label: "Pricing", className: "w-64" },
	{ label: "Docs", className: "w-16" },
] as const;

/**
 * One category of the index as a spec table: the product (linked to its page),
 * what it is, its release state, its published price and its docs. Below md
 * the table scrolls sideways inside its own frame, never the page.
 */
export function ProductsIndexTable({
	group,
	headingId,
}: {
	group: ProductsIndexGroup;
	/** Id of the category heading, which names the table's scroll region. */
	headingId: string;
}) {
	const { category, rows } = group;
	return (
		<section aria-labelledby={headingId} data-products-index-group={category}>
			<div className="mb-4 flex items-baseline justify-between gap-4">
				<h3
					className="font-heading font-medium text-foreground text-xl md:text-2xl"
					id={headingId}
				>
					{category}
				</h3>
				<p className="font-mono text-muted-foreground text-xs tabular-nums">
					<ProductCount count={rows.length} />
				</p>
			</div>
			<ScrollRegion label={category}>
				<table className="w-full min-w-4xl border-collapse border-border border-t text-start text-sm">
					<caption className="sr-only">
						{tl("{category} products", { category })}
					</caption>
					<thead>
						<tr className="border-border border-b">
							{COLUMNS.map((column) => (
								<th
									className={cn(
										"py-3 pe-6 font-medium text-muted-foreground text-xs last:pe-0",
										column.className
									)}
									key={column.label}
									scope="col"
								>
									{column.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<ProductRow key={row.slug} row={row} />
						))}
					</tbody>
				</table>
			</ScrollRegion>
		</section>
	);
}
