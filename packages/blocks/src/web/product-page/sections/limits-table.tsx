"use client";

import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { localizeProfileLimits } from "../profile-locale-values.ts";
import type { ProductLimits } from "../profile-types.ts";
import { ProductSection, ProductSectionHeader } from "./section-shell.tsx";

/**
 * Limits and rates as a two-column reference table: what is metered, its
 * published value (tabular figures, so numbers align) and an optional note.
 * Priced values are formatted for the page's locale (../profile-locale-values.ts).
 */
export function ProductLimitsTable({
	limits: published,
}: {
	limits: ProductLimits;
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	// Prices and counts in the reader's digits and currency placement.
	const limits = localizeProfileLimits(published, tl, locale);
	if (limits.rows.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-limits">
			<ProductSectionHeader
				kicker="Limits and rates"
				size="small"
				title={limits.title}
			/>
			<table className="w-full border-border border-t text-start text-sm">
				<thead className="sr-only">
					<tr>
						<th scope="col">Item</th>
						<th scope="col">Value</th>
					</tr>
				</thead>
				<tbody>
					{limits.rows.map((row) => (
						<tr
							className="border-border border-b align-baseline"
							key={row.label}
						>
							<th
								className="w-1/2 py-4 pe-6 font-normal text-muted-foreground"
								scope="row"
							>
								{row.label}
							</th>
							<td className="py-4">
								<span className="font-heading font-medium text-base text-foreground tabular-nums">
									{row.value}
								</span>
								{row.note ? (
									<span className="mt-1 block text-pretty text-muted-foreground text-xs leading-relaxed">
										{row.note}
									</span>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</ProductSection>
	);
}
