import { cn } from "@ryu/ui/lib/utils";
import type {
	ProductAvailabilityRow,
	ProductAvailabilityState,
} from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionItemTitleClass,
} from "./section-shell.tsx";

/** The word for each state, always shown: the glyph only reinforces it. */
export const AVAILABILITY_STATE_LABELS: Readonly<
	Record<ProductAvailabilityState, string>
> = {
	available: "Available",
	"early-access": "Early access",
	planned: "Planned",
	"not-planned": "Not planned",
};

const GLYPH_CLASSES: Readonly<Record<ProductAvailabilityState, string>> = {
	available: "h-2.5 rounded-full bg-foreground",
	"early-access": "h-2.5 rounded-full border-2 border-foreground",
	planned: "h-2.5 rounded-full border border-muted-foreground border-dashed",
	"not-planned": "h-0.5 bg-muted-foreground",
};

function StateGlyph({ state }: { state: ProductAvailabilityState }) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block w-2.5 shrink-0", GLYPH_CLASSES[state])}
		/>
	);
}

/**
 * Where a workspace runs: one tile per platform with its state in words and a
 * shape (filled, ring, dashed ring, dash) so the states differ without colour.
 */
export function ProductAvailabilityMatrix({
	rows,
	title = "Where it runs",
}: {
	rows: readonly ProductAvailabilityRow[];
	title?: string;
}) {
	if (rows.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-availability">
			<ProductSectionHeader kicker="Availability" size="small" title={title} />
			<ul
				className={cn(
					"grid gap-3 sm:grid-cols-2",
					rows.length >= 3 && "lg:grid-cols-3",
					rows.length >= 4 && rows.length % 3 !== 0 && "xl:grid-cols-4"
				)}
			>
				{rows.map((row) => (
					<li
						className={cn(
							"flex min-w-0 flex-col gap-3 rounded-2xl p-5",
							row.state === "available" || row.state === "early-access"
								? "bg-muted/50"
								: "bg-muted/20"
						)}
						data-availability-state={row.state}
						data-product-card=""
						data-product-card-tone={
							row.state === "available" || row.state === "early-access"
								? undefined
								: "quiet"
						}
						key={row.platform}
					>
						<h3 className={sectionItemTitleClass}>{row.platform}</h3>
						<p className="flex items-center gap-2 font-medium text-foreground text-sm">
							<StateGlyph state={row.state} />
							{AVAILABILITY_STATE_LABELS[row.state]}
						</p>
						{row.note ? (
							<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
								{row.note}
							</p>
						) : null}
					</li>
				))}
			</ul>
		</ProductSection>
	);
}
