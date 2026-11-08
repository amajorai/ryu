import type { LiteralMessage } from "@ryu/i18n/react";
import type { Product } from "../../data/products.tsx";
import type {
	FactSheetColumns,
	FactSheetFact,
} from "../../page-sections/fact-sheet.tsx";
import { productBaseFacts } from "../base-facts.ts";
import type { ProductProfile } from "../profile-types.ts";
import { LocalizedFactSheet } from "./localized-pricing-lead.tsx";
import { ProductSection, sectionKickerClass } from "./section-shell.tsx";

/**
 * Base facts (availability, category, pricing, docs) then the profile's own
 * facts. A label appears once: the first occurrence wins, so a profile cannot
 * restate a typed base fact with different words. `tl` and `locale` translate
 * and format the pricing fact (English by default).
 */
export function atAGlanceFacts(
	product: Product,
	profile: ProductProfile | undefined,
	tl?: LiteralMessage,
	locale?: string | null
): FactSheetFact[] {
	const seen = new Set<string>();
	const facts: FactSheetFact[] = [];
	for (const fact of [
		...productBaseFacts(product, tl, locale),
		...(profile?.facts ?? []),
	]) {
		if (seen.has(fact.label)) {
			continue;
		}
		seen.add(fact.label);
		facts.push({
			label: fact.label,
			value: fact.value,
			href: fact.href,
			external: fact.external,
		});
	}
	return facts;
}

export type AtAGlanceLayout = "sheet" | "spec";

/**
 * "At a glance" as a spec sheet. `sheet` is a titled grid; `spec` puts the
 * product name and tagline in a left column beside a two-column sheet, the
 * way a datasheet opens (infrastructure pages, inside a tinted band).
 */
export function ProductAtAGlance({
	product,
	profile,
	layout = "sheet",
	columns = 3,
}: {
	product: Product;
	profile?: ProductProfile;
	layout?: AtAGlanceLayout;
	columns?: FactSheetColumns;
}) {
	const facts = atAGlanceFacts(product, profile);
	if (facts.length === 0) {
		return null;
	}
	if (layout === "spec") {
		return (
			<ProductSection testId="product-at-a-glance">
				<div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
					<header className="min-w-0">
						<h2 className={sectionKickerClass}>At a glance</h2>
						<p className="mt-4 text-balance font-heading font-medium text-2xl text-foreground leading-snug tracking-tight md:text-3xl">
							{product.name}
						</p>
						<p className="mt-3 max-w-sm text-pretty text-muted-foreground text-sm leading-relaxed">
							{product.tagline}
						</p>
					</header>
					<LocalizedFactSheet
						className="min-w-0"
						columns={2}
						facts={facts}
						slug={product.slug}
					/>
				</div>
			</ProductSection>
		);
	}
	return (
		<ProductSection testId="product-at-a-glance">
			<LocalizedFactSheet
				className="min-w-0"
				columns={columns}
				facts={facts}
				slug={product.slug}
				title="At a glance"
			/>
		</ProductSection>
	);
}
