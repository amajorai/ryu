import { cn } from "@ryu/ui/lib/utils";
import { landingSectionClass } from "../landing-typography.ts";
import { sectionKickerClass } from "../product-page/sections/section-shell.tsx";
import {
	PRODUCTS_INDEX_AVAILABILITY_LABELS,
	type ProductsIndexAvailability,
	type ProductsIndexSummary as Summary,
} from "./products-index-data.ts";
import { AVAILABILITY_MARKERS } from "./products-index-table.tsx";

const AVAILABILITY_ORDER: readonly ProductsIndexAvailability[] = [
	"available",
	"early-access",
	"coming-soon",
];

/** Bar segments: the same filled / tinted / quiet ladder as the chip markers. */
const BAR_TONES: Readonly<Record<ProductsIndexAvailability, string>> = {
	available: "bg-foreground",
	"early-access": "bg-foreground/40",
	"coming-soon": "bg-muted-foreground/20",
};

const figureClass =
	"font-heading font-medium text-3xl text-foreground tabular-nums tracking-tight md:text-4xl";

/**
 * The catalog in numbers, counted from the rows the index shows: the total,
 * each category, and how many products are available today versus still in
 * early access or coming soon. A proportional bar draws the release split;
 * the legend beside it carries the same counts as text.
 */
export function ProductsIndexSummary({ summary }: { summary: Summary }) {
	const shown = AVAILABILITY_ORDER.filter(
		(state) => summary.byAvailability[state] > 0
	).map((id) => ({ id, label: PRODUCTS_INDEX_AVAILABILITY_LABELS[id] }));
	return (
		<section
			aria-labelledby="products-index-summary-title"
			className={landingSectionClass}
			data-testid="products-index-summary"
		>
			<h2 className={sectionKickerClass} id="products-index-summary-title">
				The catalog at a glance
			</h2>
			<dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-8 border-border border-t pt-8 sm:grid-cols-3 lg:grid-cols-5">
				<div
					className="col-span-2 sm:col-span-1"
					data-products-index-count="total"
				>
					<dt className="text-muted-foreground text-sm">Products</dt>
					<dd className={cn(figureClass, "mt-2")}>{summary.total}</dd>
				</div>
				{summary.byCategory.map((entry) => (
					<div data-products-index-count={entry.category} key={entry.category}>
						<dt className="text-muted-foreground text-sm">{entry.category}</dt>
						<dd className={cn(figureClass, "mt-2 text-muted-foreground")}>
							{entry.count}
						</dd>
					</div>
				))}
			</dl>
			<div className="mt-10 grid gap-5 md:grid-cols-2 md:items-center md:gap-10">
				<div
					aria-hidden="true"
					className="flex h-2.5 gap-1 overflow-hidden rounded-full"
					data-products-index-bar=""
				>
					{shown.map((state) => (
						<span
							className={cn("rounded-full", BAR_TONES[state.id])}
							data-products-index-bar-segment={state.id}
							key={state.id}
							style={{ flexGrow: summary.byAvailability[state.id] }}
						/>
					))}
				</div>
				<dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
					{shown.map((state) => (
						<div
							className="flex items-center gap-2"
							data-products-index-count={state.id}
							key={state.id}
						>
							<dt className="flex items-center gap-2 text-muted-foreground">
								<span
									aria-hidden="true"
									className={cn(
										"size-2 shrink-0 rounded-full",
										AVAILABILITY_MARKERS[state.id]
									)}
								/>
								{state.label}
							</dt>
							<dd className="font-medium text-foreground tabular-nums">
								{summary.byAvailability[state.id]}
							</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}
