"use client";

import {
	useLiteralMessages,
	useOptionalI18n,
	useRichLiteralMessages,
} from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { planCardConicGradient } from "@ryu/ui/components/plan-badge";
import { cn } from "@ryu/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { PRODUCT_REALMS } from "./data/product-realm-list.ts";
import {
	getStandaloneProductPricing,
	type StandaloneProductPricing,
	standaloneProductPricing,
} from "./data/standalone-pricing.ts";
import {
	type StandalonePricePoint,
	standalonePricePoints,
} from "./data/standalone-pricing-points.ts";
import {
	landingContainerClass,
	landingSectionClass,
	landingSubheadlineBodyClass,
} from "./landing-typography.ts";
import { LinkArrow } from "./link-arrow.tsx";
import motionStyles from "./pricing-motion.module.css";
import { SectionHeading } from "./sections.tsx";

// A long price line keeps only its first clause as the lead; the rest moves
// into "Usage details" so the lead stays one short muted line.
const LEAD_MAX_CHARS = 140;
const LEAD_BREAK = /[.;]\s+(?=\S)/;
// "$0.025" in English; "0,025 $" or "US$0.025" where the locale places the
// symbol after the figure or spells the currency out.
const DOLLAR_FIGURE = /(?:US)?\$[\d.,]+|[\d.,]+[\s\u00a0\u202f]?(?:US)?\$/u;

function splitPriceLead(price: string): { lead: string; rest: string | null } {
	if (price.length <= LEAD_MAX_CHARS) {
		return { lead: price, rest: null };
	}
	const match = LEAD_BREAK.exec(price);
	if (!match) {
		return { lead: price, rest: null };
	}
	const lead = `${price.slice(0, match.index)}.`;
	const remainder = price.slice(match.index + match[0].length);
	return {
		lead,
		rest: remainder.charAt(0).toUpperCase() + remainder.slice(1),
	};
}

function PriceLead({ text }: { text: string }) {
	const match = DOLLAR_FIGURE.exec(text);
	if (!match) {
		return text;
	}
	const end = match.index + match[0].length;
	return (
		<>
			{text.slice(0, match.index)}
			<strong className="font-medium text-foreground">{match[0]}</strong>
			{text.slice(end)}
		</>
	);
}

function productHref(slug: string): Route {
	// SAFETY: The sole caller passes entry.slug from STANDALONE_PRODUCT_PRICING after its catalog lookup succeeded; /products/[slug]/page.tsx owns this nonliteral route family.
	return `/products/${slug}` as Route;
}

/** The headline figures of one product: the amount first, its unit under it. */
function PricePoints({ points }: { points: readonly StandalonePricePoint[] }) {
	if (points.length === 0) {
		return null;
	}
	return (
		<dl
			className={cn(
				"grid gap-x-4 gap-y-3 rounded-xl bg-muted p-4",
				points.length >= 3 && "grid-cols-3",
				points.length === 2 && "grid-cols-2"
			)}
			data-price-points
		>
			{points.map((point) => (
				// The unit is the term and the amount its value; reversed on screen
				// so the amount leads.
				<div className="flex min-w-0 flex-col-reverse gap-1" key={point.id}>
					<dt className="text-pretty text-muted-foreground text-xs leading-snug">
						{point.unit}
					</dt>
					<dd className="font-heading font-medium text-2xl tabular-nums tracking-tight">
						{point.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

function StandaloneProductPricingCard({
	entry,
}: {
	entry: StandaloneProductPricing;
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const tlRich = useRichLiteralMessages();
	const isGatewayPayg = entry.slug === "gateway";
	const realm = PRODUCT_REALMS.find((candidate) => candidate.id === entry.slug);
	const points = standalonePricePoints(entry.slug, tl, locale);
	const card = (
		<Card
			className={isGatewayPayg ? "relative h-full" : "h-full"}
			data-standalone-product={entry.slug}
		>
			<CardHeader>
				<div className="flex min-h-8 items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2.5">
						{realm ? (
							<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
								<realm.icon aria-hidden="true" className="size-4" />
							</span>
						) : null}
						<CardTitle variant="subsection">{entry.name}</CardTitle>
					</div>
					{/* Flat like the card: an early access badge sits on the page shade,
					    a released one on the raised shade. Neither has a border. */}
					<Badge
						className={cn(
							"shrink-0 text-[13px]",
							entry.status === "Early access" &&
								"border-transparent bg-background"
						)}
						variant={entry.status === "Early access" ? "outline" : "secondary"}
					>
						{entry.status}
					</Badge>
				</div>
				{/* What the product is, in the one line the product menu uses. */}
				{realm ? (
					<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
						{realm.description}
					</p>
				) : null}
			</CardHeader>
			<CardContent className="h-full" layout="stack">
				<PricePoints points={points} />
				{/* The full published price: fine print under the figures, and the
				    only price line for a product with no published rate. Phones
				    clamp it; the product page carries the rest. */}
				<p
					className={cn(
						"text-muted-foreground leading-relaxed max-md:line-clamp-3",
						points.length > 0 ? "text-xs" : "text-sm"
					)}
					data-standalone-price
				>
					{entry.price}
				</p>
				{/* One link per product: the product page carries the usage detail. */}
				<Link
					className="mt-auto inline-flex min-h-10 items-center gap-1 self-start font-medium text-foreground text-sm underline-offset-4 hover:underline"
					href={productHref(entry.slug)}
				>
					{tlRich(
						"Details<srOnly> for {name}</srOnly>",
						{ name: entry.name },
						{ srOnly: (content) => <span className="sr-only">{content}</span> }
					)}
					<LinkArrow />
				</Link>
			</CardContent>
		</Card>
	);

	if (!isGatewayPayg) {
		return card;
	}

	// No plain border, like the rest of the catalog. The Gateway card shows
	// its gradient ring on hover.
	return (
		<div
			className="group relative h-full rounded-[calc(var(--radius-xl)+2px)] p-[2px]"
			data-testid="standalone-pricing-card-gateway"
		>
			<div
				aria-hidden="true"
				className={`t-card-border-spin pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:animate-none ${motionStyles.idleRing}`}
				style={{ backgroundImage: planCardConicGradient("gateway-payg") }}
			/>
			{card}
		</div>
	);
}

export function StandaloneProductPricingSection({ slug }: { slug: string }) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const entry = getStandaloneProductPricing(slug, tl, locale);
	if (!entry) {
		return null;
	}
	const { lead, rest } = splitPriceLead(entry.price);
	const details = [...(rest ? [rest] : []), ...entry.details.slice(0, 3)];

	return (
		<section
			aria-label={tl("{productName} pricing", { productName: entry.name })}
			// A short block: a reduced shell keeps it from floating between full section gaps.
			className={cn(landingSectionClass, "md:py-20 lg:py-20")}
			data-testid={`standalone-pricing-${slug}`}
			id="standalone-pricing"
		>
			<SectionHeading
				className="mb-4"
				title={tl("{productName} pricing", { productName: entry.name })}
			/>
			<div className="max-w-2xl">
				{/* "Available" needs no note, and "Early access" already sits in the
				    product hero's eyebrow; only pricing statuses such as "Included"
				    or "Metered" add information here. */}
				{entry.status === "Available" ||
				entry.status === "Early access" ? null : (
					<p className="mb-2 text-muted-foreground text-sm">{entry.status}</p>
				)}
				<p className={landingSubheadlineBodyClass}>
					<PriceLead text={lead} />
				</p>
				<div className="mt-4 flex items-start gap-6">
					<Link
						className="inline-flex min-h-10 shrink-0 items-center gap-1 font-medium text-foreground text-sm underline-offset-4 hover:underline"
						href="/pricing"
					>
						See all pricing
						<LinkArrow />
					</Link>
					{details.length > 0 ? (
						<details className="min-w-0">
							<summary className="inline-flex min-h-10 cursor-pointer items-center rounded-sm font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
								Usage details
							</summary>
							<ul className="mt-1 space-y-2 text-muted-foreground text-sm leading-relaxed">
								{details.map((detail) => (
									<li className="flex gap-2.5" key={detail}>
										<span
											aria-hidden="true"
											className="mt-2 size-1 shrink-0 rounded-full bg-foreground/40"
										/>
										<span>{detail}</span>
									</li>
								))}
							</ul>
						</details>
					) : null}
				</div>
			</div>
		</section>
	);
}

const NO_HIDDEN_SERVICES: readonly string[] = [];

/** One group of product cards under its own small heading. */
function CatalogGroup({
	entries,
	id,
	note,
	title,
}: {
	entries: readonly StandaloneProductPricing[];
	id: string;
	note?: string;
	title: string;
}) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<div data-standalone-group={id}>
			<div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h3 className="font-heading font-medium text-lg tracking-tight">
					{title}
				</h3>
				{note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
			</div>
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				{entries.map((entry) => (
					<StandaloneProductPricingCard entry={entry} key={entry.slug} />
				))}
			</div>
		</div>
	);
}

/**
 * "Standalone product pricing": one card per rolled-out product, with what
 * it is, its headline figures, its access status, and a link to its product
 * page. Products with a published rate or allowance come first; early-access
 * products follow in their own group.
 */
export function StandaloneProductPricingCatalog({
	hiddenSlugs = NO_HIDDEN_SERVICES,
}: {
	/**
	 * Standalone services the host has not rolled out. Their cards are left out
	 * at render time; `STANDALONE_PRODUCT_PRICING` keeps every row so the
	 * published rates and their drift tests stay intact.
	 */
	hiddenSlugs?: readonly string[];
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const hidden = new Set(hiddenSlugs);
	const entries = standaloneProductPricing(tl, locale).filter(
		(entry) => !hidden.has(entry.slug)
	);
	const earlyAccess = entries.filter(
		(entry) => entry.status === "Early access"
	);
	const open = entries.filter((entry) => entry.status !== "Early access");
	return (
		<section
			aria-label="Standalone product pricing"
			className={cn(landingContainerClass, "scroll-mt-20 py-12 md:py-16")}
			data-testid="standalone-pricing-catalog"
			id="standalone-pricing"
		>
			<SectionHeading
				className="mb-8 md:mb-10"
				subtitle="Other Ryu products have their own pricing. Current rates and access status are listed here; product pages explain the details."
				title="Standalone product pricing"
			/>
			{entries.length > 0 ? (
				<div className="flex flex-col gap-10">
					<CatalogGroup entries={open} id="open" title={tl("Available now")} />
					<CatalogGroup
						entries={earlyAccess}
						id="early-access"
						note={tl("No self-serve hosted checkout yet")}
						title={tl("Early access")}
					/>
				</div>
			) : (
				<p
					className="rounded-2xl bg-card px-5 py-4 text-muted-foreground text-sm"
					data-testid="standalone-pricing-early-access"
				>
					Standalone services are in early access and are not open for new
					purchases yet.
				</p>
			)}
		</section>
	);
}
