import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";
import { LinkArrow } from "../../link-arrow.tsx";
import { nextLinkHref } from "../../next-link-href.ts";
import type { ProductCatalog, ProductCatalogItem } from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionItemTitleClass,
} from "./section-shell.tsx";

/**
 * Columns that leave no lone card on the last row at lg: two or four entries
 * fill one row, and anything else uses the three-column directory.
 */
export function catalogGridColumnsClass(count: number): string {
	if (count <= 2) {
		return "sm:grid-cols-2";
	}
	if (count === 4) {
		return "sm:grid-cols-2 lg:grid-cols-4";
	}
	return "sm:grid-cols-2 lg:grid-cols-3";
}

const cardClass =
	"flex h-full min-w-0 flex-col gap-3 rounded-2xl bg-muted/50 p-5 md:p-6";

function CardBody({
	item,
	index,
}: {
	item: ProductCatalogItem;
	index: number;
}) {
	return (
		<>
			<span className="flex items-center justify-between font-mono text-muted-foreground text-xs tabular-nums">
				<span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
				{item.href ? (
					<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground group-hover:rtl:-translate-x-0.5" />
				) : null}
			</span>
			<h3 className={sectionItemTitleClass}>{item.title}</h3>
			<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
				{item.description}
			</p>
		</>
	);
}

function CatalogCard({
	item,
	index,
}: {
	item: ProductCatalogItem;
	index: number;
}): ReactNode {
	if (!item.href) {
		return (
			<div className={cardClass} data-product-card="">
				<CardBody index={index} item={item} />
			</div>
		);
	}
	const external = /^https?:/.test(item.href);
	const className = cn(
		cardClass,
		"group outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
	);
	return external ? (
		<a
			className={className}
			data-product-card=""
			href={item.href}
			rel="noopener noreferrer"
			target="_blank"
		>
			<CardBody index={index} item={item} />
		</a>
	) : (
		<Link
			className={className}
			data-product-card=""
			href={nextLinkHref(item.href)}
		>
			<CardBody index={index} item={item} />
		</Link>
	);
}

/**
 * A directory of what the catalog holds (listing kinds, toolkits): a dense
 * card grid with an index number per entry and the count beside the title.
 */
export function ProductCatalogGrid({ catalog }: { catalog: ProductCatalog }) {
	const { countLabel = "Listed below", items, subtitle, title } = catalog;
	if (items.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-catalog">
			<ProductSectionHeader
				aside={
					<p className="flex items-baseline gap-3 md:flex-col md:items-end md:gap-1">
						<span className="font-heading font-medium text-5xl text-foreground tabular-nums tracking-tight md:text-6xl">
							{items.length}
						</span>
						<span className="text-muted-foreground text-sm">{countLabel}</span>
					</p>
				}
				kicker="Catalog"
				subtitle={subtitle}
				title={title}
			/>
			<ul
				className={cn("grid gap-3", catalogGridColumnsClass(items.length))}
				data-catalog-count={items.length}
			>
				{items.map((item, index) => (
					<li className="min-w-0" key={item.title}>
						<CatalogCard index={index} item={item} />
					</li>
				))}
			</ul>
		</ProductSection>
	);
}
