import type { ProductComparison } from "../profile-types.ts";
import { ScrollRegion } from "./scroll-region.tsx";
import { ProductSection, ProductSectionHeader } from "./section-shell.tsx";

/**
 * Options side by side (self-host vs managed, and so on). A real table with
 * column and row headers; on narrow screens it scrolls inside its own
 * focusable frame (with an edge fade), never the page. The first compared column is tinted as the reference.
 */
export function ProductComparisonTable({
	comparison,
}: {
	comparison: ProductComparison;
}) {
	const { columns, rowHeader, rows, title } = comparison;
	if (rows.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-comparison">
			<ProductSectionHeader kicker="Compare options" title={title} />
			<ScrollRegion label={title}>
				<table
					className="w-full min-w-xl border-collapse text-start text-sm"
					data-column-count={columns.length}
				>
					<caption className="sr-only">{title}</caption>
					<thead>
						<tr className="border-border border-b">
							<th
								className="w-1/4 py-4 pe-6 font-medium text-muted-foreground"
								scope="col"
							>
								{rowHeader ?? <span className="sr-only">Option</span>}
							</th>
							{columns.map((column, index) => (
								<th
									className={
										index === 0
											? "rounded-t-xl bg-muted/60 px-4 py-4 font-heading font-medium text-base text-foreground"
											: "px-4 py-4 font-heading font-medium text-base text-foreground"
									}
									key={column}
									scope="col"
								>
									{column}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr className="border-border border-b align-top" key={row.label}>
								<th
									className="py-4 pe-6 font-normal text-muted-foreground"
									scope="row"
								>
									{row.label}
								</th>
								{row.values.map((value, index) => (
									<td
										className={
											index === 0
												? "text-pretty bg-muted/60 px-4 py-4 text-foreground leading-relaxed"
												: "text-pretty px-4 py-4 text-foreground leading-relaxed"
										}
										// Values are positional: they line up with `columns`.
										key={`${columns[index] ?? index}`}
									>
										{value}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</ScrollRegion>
		</ProductSection>
	);
}
