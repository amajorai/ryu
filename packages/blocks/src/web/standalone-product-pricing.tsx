import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { planCardConicGradient } from "@ryu/ui/components/plan-badge";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import {
	getStandaloneProductPricing,
	PRICING_COPY,
	STANDALONE_PRODUCT_PRICING,
	type StandaloneProductPricing,
} from "./data/standalone-pricing.ts";
import {
	landingContainerClass,
	landingSectionClass,
	landingSubheadlineBodyClass,
} from "./landing-typography.ts";
import motionStyles from "./pricing-motion.module.css";
import { SectionHeading } from "./sections.tsx";

// A long price line keeps only its first clause as the lead; the rest moves
// into "Usage details" so the lead stays one short muted line.
const LEAD_MAX_CHARS = 140;
const LEAD_BREAK = /[.;]\s+(?=\S)/;
const DOLLAR_FIGURE = /\$[\d.,]+/;

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

function StandaloneProductPricingCard({
	entry,
}: {
	entry: StandaloneProductPricing;
}) {
	const isGatewayPayg = entry.slug === "gateway";
	const card = (
		<Card
			className={
				isGatewayPayg ? "relative h-full border-transparent" : "h-full"
			}
		>
			<CardHeader>
				<div className="flex min-h-7 items-baseline justify-between gap-3">
					<CardTitle variant="subsection">{entry.name}</CardTitle>
					<Badge className="shrink-0 text-[13px]" variant="secondary">
						{entry.status}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="h-full" layout="stack">
				{/* Phones keep each entry to name, price, and one link; the product
				    page carries the rest. */}
				<p className="text-muted-foreground text-sm leading-relaxed max-md:line-clamp-2">
					{entry.price}
				</p>
				{/* One link per product: the product page carries the usage detail. */}
				<Link
					className="mt-auto inline-flex min-h-10 items-center self-start font-medium text-foreground text-sm underline-offset-4 hover:underline"
					href={productHref(entry.slug)}
				>
					Details<span className="sr-only"> for {entry.name}</span>
					&nbsp;<span aria-hidden="true">→</span>
				</Link>
			</CardContent>
		</Card>
	);

	if (!isGatewayPayg) {
		return card;
	}

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
	const entry = getStandaloneProductPricing(slug);
	if (!entry) {
		return null;
	}
	const { lead, rest } = splitPriceLead(entry.price);
	const details = [...(rest ? [rest] : []), ...entry.details.slice(0, 3)];

	return (
		<section
			aria-label={`${entry.name} pricing`}
			// A short block: a reduced shell keeps it from floating between full section gaps.
			className={cn(landingSectionClass, "md:py-20 lg:py-20")}
			data-testid={`standalone-pricing-${slug}`}
			id="standalone-pricing"
		>
			<SectionHeading className="mb-4" title={`${entry.name} pricing`} />
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
						See all pricing <span aria-hidden="true">→</span>
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
	const hidden = new Set(hiddenSlugs);
	const entries = STANDALONE_PRODUCT_PRICING.filter(
		(entry) => !hidden.has(entry.slug)
	);
	return (
		<section
			aria-label="Standalone product pricing"
			className={cn(landingContainerClass, "py-12 md:py-16")}
			data-testid="standalone-pricing-catalog"
			id="standalone-pricing"
		>
			<SectionHeading
				className="mb-8 md:mb-10"
				subtitle="Other Ryu products have their own pricing. Current rates and access status are listed here; product pages explain the details."
				title="Standalone product pricing"
			/>
			{entries.length > 0 ? (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
					{entries.map((entry) => (
						<StandaloneProductPricingCard entry={entry} key={entry.slug} />
					))}
				</div>
			) : (
				<p
					className="rounded-2xl border border-border/60 border-dashed px-5 py-4 text-muted-foreground text-sm"
					data-testid="standalone-pricing-early-access"
				>
					Standalone services are in early access and are not open for new
					purchases yet.
				</p>
			)}
			<details className="group mt-6 rounded-2xl border border-border/60 bg-muted/20 px-5 py-4">
				<summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-4 rounded-sm font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
					Marketplace and credit fees
					<ChevronDown
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
					/>
				</summary>
				<div className="mt-3 text-muted-foreground text-sm leading-relaxed">
					<p>
						Ryu Marketplace purchases are seller-priced. Ryu's current
						commission is 20% of the pre-tax item price; Stripe processing is
						separate and can vary by payment method, card country, currency, and
						Ryu's Stripe agreement.
					</p>
					<p className="mt-2">
						{tl(
							"Manual no-plan top-ups use a {baseDepositFee} deposit fee with a {depositFeeMinimum} minimum. Active plans receive lower rates: {proDepositFee} on Pro and {teamDepositFee} on Max, Teams, and Business. Enterprise rates are contracted. A prepaid balance enables managed Gateway; other product access and metering remain separate.",
							{
								baseDepositFee: PRICING_COPY.baseDepositFee,
								depositFeeMinimum: PRICING_COPY.depositFeeMinimum,
								proDepositFee: PRICING_COPY.proDepositFee,
								teamDepositFee: PRICING_COPY.teamDepositFee,
							}
						)}
					</p>
				</div>
			</details>
		</section>
	);
}
