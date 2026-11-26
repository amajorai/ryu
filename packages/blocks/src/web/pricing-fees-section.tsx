"use client";

import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type PricingFormat,
	PUBLISHED_PRICING,
	pricingFormat,
} from "./data/standalone-pricing.ts";
import { landingContainerClass } from "./landing-typography.ts";
import { SectionHeading } from "./sections.tsx";

const BPS_PER_UNIT = 10_000;

/** The top-up the worked example prices: the smallest preset in the billing docs. */
export const EXAMPLE_TOP_UP_USD = 100;

/**
 * Ryu's Marketplace commission on the pre-tax item price, in basis points.
 * Published in `apps/fumadocs/content/docs/billing/plans.mdx` ("Marketplace
 * pricing"); `pricing-fees-section.test.tsx` checks the docs against it.
 */
export const MARKETPLACE_COMMISSION_BPS = 2000;

/** The deposit fee on `amountUsd` of credits at `bps`: the rate or the minimum, whichever is greater. */
export function exampleDepositFeeUsd(
	bps: number,
	amountUsd = EXAMPLE_TOP_UP_USD
): number {
	return Math.max(
		(amountUsd * bps) / BPS_PER_UNIT,
		PUBLISHED_PRICING.depositFee.minimumUsd
	);
}

/** "$127", "$126.50": whole dollars stay whole. */
function usd(format: PricingFormat, amount: number): string {
	return format.usd(amount, Number.isInteger(amount) ? 0 : 2);
}

interface BarPart {
	id: string;
	label: string;
	/** Share of the bar, in any unit: the parts are sized against their sum. */
	share: number;
	tone: "strong" | "soft";
	value: string;
}

/**
 * One amount split into its parts: a drawn bar (decoration) over a real
 * definition list, so the same figures are read as text.
 */
function SplitBar({ parts }: { parts: readonly BarPart[] }) {
	return (
		<div>
			<div
				aria-hidden="true"
				className="flex h-3 gap-1 overflow-hidden rounded-full"
			>
				{parts.map((part) => (
					<span
						className={cn(
							"h-full rounded-full",
							part.tone === "strong" ? "bg-primary" : "bg-primary/30"
						)}
						key={part.id}
						style={{ flexGrow: part.share, flexBasis: 0 }}
					/>
				))}
			</div>
			<dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				{parts.map((part) => (
					<div className="flex items-center gap-2" key={part.id}>
						<span
							aria-hidden="true"
							className={cn(
								"size-2 shrink-0 rounded-full",
								part.tone === "strong" ? "bg-primary" : "bg-primary/30"
							)}
						/>
						<dt className="text-muted-foreground">{part.label}</dt>
						<dd className="font-medium tabular-nums" data-fee-part={part.id}>
							{part.value}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

const cardClass =
	"flex flex-col gap-5 rounded-2xl border border-border/60 bg-card p-5 md:p-6";
const cardTitleClass = "font-heading font-medium text-lg tracking-tight";
const cardLeadClass = "text-muted-foreground text-sm leading-relaxed";
const noteClass = "text-muted-foreground text-xs leading-relaxed";

/**
 * "Marketplace and credit fees": the two fees Ryu charges besides a plan.
 * Each is drawn as a split bar with its real percentages, and the top-up fee
 * also gets a worked example and a table of every plan's rate. All figures
 * come from `PUBLISHED_PRICING` and {@link MARKETPLACE_COMMISSION_BPS}.
 */
export function PricingFeesSection() {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const format = pricingFormat(locale);
	const { depositFee } = PUBLISHED_PRICING;
	const example = usd(format, EXAMPLE_TOP_UP_USD);
	const baseFee = exampleDepositFeeUsd(depositFee.baseBps);
	const rates = [
		{ bps: depositFee.baseBps, id: "none", plan: tl("No plan") },
		{ bps: depositFee.proBps, id: "pro", plan: "Pro" },
		{
			bps: depositFee.teamBps,
			id: "team",
			plan: tl("Max, Teams, and Business"),
		},
	];
	return (
		<section
			aria-label="Marketplace and credit fees"
			className={cn(landingContainerClass, "scroll-mt-20 py-12 md:py-16")}
			data-testid="pricing-fees"
			id="fees"
		>
			<SectionHeading
				className="mb-8 md:mb-10"
				subtitle="Two fees apply outside a plan: one when you buy extra credits, one on paid Marketplace items."
				title="Marketplace and credit fees"
			/>
			<div className="grid gap-4 lg:grid-cols-2">
				<div className={cardClass} data-fee-card="top-up">
					<div>
						<h3 className={cardTitleClass}>Credit top-ups</h3>
						<p className={cn(cardLeadClass, "mt-1.5")}>
							A one-time deposit fee is added on top of the credits you buy. The
							full amount of credits goes to your wallet.
						</p>
					</div>
					<div>
						<p className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
							<span className="text-muted-foreground">
								{tl("Example: {amount} of credits without a plan", {
									amount: example,
								})}
							</span>
							<span>
								<span className="text-muted-foreground">You pay</span>{" "}
								<span
									className="font-heading font-medium text-2xl tabular-nums tracking-tight"
									data-fee-example-total
								>
									{usd(format, EXAMPLE_TOP_UP_USD + baseFee)}
								</span>
							</span>
						</p>
						<SplitBar
							parts={[
								{
									id: "credits",
									label: tl("Credits in your wallet"),
									share: EXAMPLE_TOP_UP_USD,
									tone: "strong",
									value: example,
								},
								{
									id: "deposit-fee",
									label: tl("Deposit fee ({rate})", {
										rate: format.bps(depositFee.baseBps),
									}),
									share: baseFee,
									tone: "soft",
									value: usd(format, baseFee),
								},
							]}
						/>
					</div>
					<table className="w-full border-collapse text-sm">
						<caption className="sr-only">Deposit fee by plan</caption>
						<thead>
							<tr className="text-muted-foreground text-xs">
								<th className="py-2 pe-3 text-start font-medium" scope="col">
									Plan
								</th>
								<th className="px-3 py-2 text-end font-medium" scope="col">
									Deposit fee
								</th>
								<th className="py-2 ps-3 text-end font-medium" scope="col">
									{tl("You pay for {amount} of credits", { amount: example })}
								</th>
							</tr>
						</thead>
						<tbody>
							{rates.map((rate) => (
								<tr
									className="border-border/60 border-t"
									data-fee-rate={rate.id}
									key={rate.id}
								>
									<th
										className="py-2.5 pe-3 text-start font-normal"
										scope="row"
									>
										{rate.plan}
									</th>
									<td className="px-3 py-2.5 text-end tabular-nums">
										{format.bps(rate.bps)}
									</td>
									<td className="py-2.5 ps-3 text-end font-medium tabular-nums">
										{usd(
											format,
											EXAMPLE_TOP_UP_USD + exampleDepositFeeUsd(rate.bps)
										)}
									</td>
								</tr>
							))}
							<tr
								className="border-border/60 border-t"
								data-fee-rate="enterprise"
							>
								<th className="py-2.5 pe-3 text-start font-normal" scope="row">
									Enterprise
								</th>
								<td
									className="py-2.5 ps-3 text-end text-muted-foreground"
									colSpan={2}
								>
									Contracted
								</td>
							</tr>
						</tbody>
					</table>
					<p className={noteClass}>
						{tl(
							"The fee is the rate above or {depositFeeMinimum}, whichever is greater. A prepaid balance enables managed Gateway; other product access and metering remain separate.",
							{ depositFeeMinimum: usd(format, depositFee.minimumUsd) }
						)}
					</p>
				</div>
				<div className={cardClass} data-fee-card="marketplace">
					<div>
						<h3 className={cardTitleClass}>Marketplace purchases</h3>
						<p className={cn(cardLeadClass, "mt-1.5")}>
							{tl(
								"Sellers set the price of paid Marketplace items. Ryu's current commission is {commission} of the pre-tax item price.",
								{ commission: format.bps(MARKETPLACE_COMMISSION_BPS) }
							)}
						</p>
					</div>
					<div>
						<p className="mb-3 text-muted-foreground text-sm">
							Where the pre-tax item price goes
						</p>
						<SplitBar
							parts={[
								{
									id: "seller",
									label: tl("Seller"),
									share: BPS_PER_UNIT - MARKETPLACE_COMMISSION_BPS,
									tone: "strong",
									value: format.bps(BPS_PER_UNIT - MARKETPLACE_COMMISSION_BPS),
								},
								{
									id: "commission",
									label: tl("Ryu commission"),
									share: MARKETPLACE_COMMISSION_BPS,
									tone: "soft",
									value: format.bps(MARKETPLACE_COMMISSION_BPS),
								},
							]}
						/>
					</div>
					<p className={cn(noteClass, "mt-auto")}>
						Stripe processing is separate and can vary by payment method, card
						country, currency, and Ryu's Stripe agreement.
					</p>
				</div>
			</div>
		</section>
	);
}
