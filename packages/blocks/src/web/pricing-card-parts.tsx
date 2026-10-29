"use client";

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Card, CardDescription } from "@ryu/ui/components/card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import {
	type PlanTier,
	planCardConicGradient,
} from "@ryu/ui/components/plan-badge";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, Coins } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import styles from "./pricing.module.css";
import {
	useHelperTextSize,
	useIsPublicPricing,
	usePlanCtaShape,
	usePricingCtaVariant,
} from "./pricing-appearance.tsx";
import motionStyles from "./pricing-motion.module.css";
import { usePauseMotionOffscreen } from "./pricing-motion.ts";
import {
	annualTotalPrice,
	type CloudHostingTier,
	type CurrentPricingPlan,
	depositFeeLine,
	effectiveMonthlyPrice,
	type PricingPlanSlug,
} from "./pricing-plan-prices.ts";
import { SubscriptionAgreement } from "./subscription-agreement.tsx";

/**
 * The price block for a recurring plan. Yearly billing shows the discounted
 * monthly equivalent with the true annual total spelled out beneath.
 *
 * The headline is always the PER-PERSON price — the number the plan is
 * advertised at — so the comparison across cards stays apples-to-apples; the
 * multiplied total for the chosen seat count is spelled out underneath so the
 * buyer still sees what they will actually pay. `perSeat` only controls the
 * "/seat" suffix (Teams is advertised per seat; Max is advertised at a flat
 * $99/mo), and is independent of `seats`.
 */
export function PriceBlock({
	monthly,
	isYearly,
	perSeat = false,
	seats = 1,
	totalMonthly = false,
}: {
	monthly: number;
	isYearly: boolean;
	perSeat?: boolean;
	seats?: number;
	/** When true, `monthly` is already the total for the selected seats. */
	totalMonthly?: boolean;
}) {
	const tl = useLiteralMessages();
	const annualTotal = annualTotalPrice(monthly);
	const perMonth = effectiveMonthlyPrice(monthly, isYearly);
	const seat = perSeat ? "/seat" : "";
	// Only more than one seat has a total worth spelling out; at one seat the
	// total IS the headline.
	const showSeatTotal = !totalMonthly && seats > 1;
	const helperText = useHelperTextSize();
	const seatTotal = perMonth * seats;
	const seatAnnualTotal = annualTotal * seats;
	const priceAmount = (value: number, headline = false) =>
		headline ? (
			<NumberTicker prefix="$" value={Math.round(value)} variant="plan-price" />
		) : (
			<span className="font-heading tabular-nums">
				<NumberTicker prefix="$" value={Math.round(value)} />
			</span>
		);
	return (
		<>
			<div className="mb-1 flex items-baseline">
				{priceAmount(perMonth, true)}
				<span className="ml-1 text-muted-foreground">{`${seat}/mo`}</span>
			</div>
			{/* The seat total and the annual total spin like the headline rather
			    than snapping. They move for the SAME reasons it does — the yearly
			    toggle and the seat stepper — so a static number beside a spinning
			    one reads as the static one having failed to update. */}
			{showSeatTotal ? (
				<p className="mb-1 flex items-baseline font-medium text-sm">
					{priceAmount(seatTotal)}
					<span className="ml-1">/mo for {seats} seats</span>
				</p>
			) : null}
			{isYearly ? (
				<p
					className={`mb-6 flex items-baseline text-muted-foreground ${helperText}`}
				>
					<span className="mr-1">Billed</span>
					{priceAmount(showSeatTotal ? seatAnnualTotal : annualTotal)}
					<span className="ml-1">
						{showSeatTotal
							? tl("per year for {seats} seats", { seats: String(seats) })
							: seat
								? "per seat per year, two months free"
								: "per year, two months free"}
					</span>
				</p>
			) : (
				<p className={`mb-6 text-muted-foreground ${helperText}`}>
					{perSeat
						? "Billed monthly per seat, cancel anytime"
						: "Billed monthly, cancel anytime"}
				</p>
			)}
		</>
	);
}

/**
 * Wraps a plan card in a 2px gradient border. The legacy Pro card keeps its
 * always-on animated conic sweep (`.t-pro-card-border`). Hosted pricing passes
 * `isRecommended` explicitly so only the recommended card keeps the same
 * conic ring visible; the other card returns to the static default border and
 * only animates on hover (`.t-card-border-spin` + {@link planCardConicGradient}).
 * The outer ring and hover layer use the same squircle corners as the card so
 * the gradient stays visible all the way around its rounded edge.
 *
 * Motion budget (pricing-motion.module.css): a hover-only ring stays paused
 * while it is hidden, and every loop in the card (rings and the plan badge)
 * pauses while the card is off screen.
 */
export function PricingCardBorder({
	isRecommended = false,
	variant,
	children,
}: {
	isRecommended?: boolean;
	variant: PlanTier;
	children: ReactNode;
}) {
	const showHighlightedBorder = isRecommended || variant === "pro";
	const frameRef = useRef<HTMLDivElement>(null);
	usePauseMotionOffscreen(frameRef);
	if (variant === "pro" && showHighlightedBorder) {
		return (
			<div
				className={cn(
					`t-pro-card-border corner-squircle relative ${styles.frame} p-0.5`,
					motionStyles.offscreenAware
				)}
				ref={frameRef}
				style={{ backgroundImage: planCardConicGradient(variant) }}
			>
				<Card
					borderTone="transparent"
					className="relative flex h-full flex-col"
				>
					{children}
				</Card>
			</div>
		);
	}

	return (
		<div
			className={cn(
				`group corner-squircle relative ${styles.frame} bg-border p-0.5 dark:bg-transparent`,
				motionStyles.offscreenAware
			)}
			ref={frameRef}
		>
			<div
				aria-hidden
				className={cn(
					`t-card-border-spin corner-squircle pointer-events-none absolute inset-0 ${styles.border} transition-opacity duration-500 ease-out`,
					showHighlightedBorder
						? "opacity-100"
						: `opacity-0 group-hover:opacity-100 ${motionStyles.idleRing}`
				)}
				style={
					{
						"--plan-border-gradient": planCardConicGradient(variant),
					} satisfies PlanBorderStyle as PlanBorderStyle
				}
			/>
			<Card borderTone="transparent" className="relative flex h-full flex-col">
				{children}
			</Card>
		</div>
	);
}

/** Shared props every individual plan card accepts. */
interface PlanBorderStyle extends CSSProperties {
	"--plan-border-gradient": string;
}

export interface PlanCardProps {
	currentPlan?: CurrentPricingPlan | null;
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
	productCount?: number;
	/** The plan's included cloud computer is out of stock, so it cannot be bought. */
	soldOut?: boolean;
}

/**
 * Extra props a SEAT-BASED plan card accepts (Teams, Max). `minSeats` mirrors
 * the plan catalog's `seatModel.minSeats` and is injected by the page — the
 * blocks package is presentational and deliberately does not depend on
 * `@ryu/auth`. The seat stepper renders only when `onSeatsChange` is supplied,
 * so read-only surfaces keep their current single-seat rendering.
 */
export interface SeatPlanCardProps extends PlanCardProps {
	cloudTiers?: readonly CloudHostingTier[];
	minSeats?: number;
	onSeatsChange?: (seats: number) => void;
	seats?: number;
}

export interface MarketplacePassPlanCardProps extends PlanCardProps {
	isYearly?: boolean;
}

/** The footer CTA shared by every plan card (current / processing / label). */
export function PlanCta({
	recurring,
	isCurrent,
	isLoading,
	label,
	onClick,
	soldOut = false,
	variant,
}: {
	recurring?: { monthly: number; isYearly: boolean };
	isCurrent: boolean;
	isLoading: boolean;
	label: string;
	onClick: () => void;
	soldOut?: boolean;
	variant?: "outline";
}) {
	const filledVariant = usePricingCtaVariant();
	const resolvedVariant = variant ?? filledVariant;
	const ctaShape = usePlanCtaShape();
	const helperText = useHelperTextSize();
	const isPublic = useIsPublicPricing();
	if (soldOut && !isCurrent) {
		return (
			<div className="flex w-full flex-col gap-2">
				<Button
					className={ctaShape.className}
					disabled
					size={ctaShape.size}
					variant={resolvedVariant}
				>
					Sold out
				</Button>
				<p className={`text-center text-muted-foreground ${helperText}`}>
					The cloud computer this plan includes is out of stock. Check back
					soon.
				</p>
			</div>
		);
	}
	const amount = recurring
		? recurring.isYearly
			? annualTotalPrice(recurring.monthly)
			: recurring.monthly
		: 0;
	const terms = recurring
		? `Renews automatically at US$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} every ${recurring.isYearly ? "year" : "month"}, plus applicable taxes, until canceled.`
		: null;
	const button = (canContinue: boolean) => (
		<Button
			className={ctaShape.className}
			disabled={!canContinue}
			loading={isLoading}
			onClick={onClick}
			size={ctaShape.size}
			variant={resolvedVariant}
		>
			{isCurrent ? "Current plan" : isLoading ? "Processing…" : label}
		</Button>
	);
	return terms ? (
		<SubscriptionAgreement
			blocked={isCurrent || isLoading}
			quiet={isPublic}
			terms={terms}
		>
			{button}
		</SubscriptionAgreement>
	) : (
		button(!(isCurrent || isLoading))
	);
}

/** Keeps inherited entitlements visually separate from a plan's own features. */
export function IncludedPlanBanner({ plan }: { plan: string }) {
	const tl = useLiteralMessages();
	return (
		<div className="mb-6">
			<p className="flex items-center gap-2 text-foreground text-sm">
				<ArrowLeft
					aria-hidden="true"
					className="size-4 shrink-0 text-foreground"
				/>
				<span>{tl("Everything in {plan}, plus", { plan })}</span>
			</p>
		</div>
	);
}

export function ProductAccessFeature({
	productCount,
}: {
	productCount?: number;
}) {
	if (!productCount) {
		return null;
	}

	return (
		<li className="flex items-start" data-product-access-feature>
			<HugeiconsIcon
				aria-hidden="true"
				className="mt-0.5 mr-2 size-4 shrink-0 text-primary"
				icon={Tick02Icon}
				strokeWidth={2}
			/>
			<span>
				Use every released Ryu product, and early-access products as they open
			</span>
		</li>
	);
}

/**
 * A plan card's feature list. The public page drops the per-row icons so the
 * list reads as plain text; product surfaces keep their icon rows.
 */
export function PlanFeatureList({ children }: { children: ReactNode }) {
	const isPublic = useIsPublicPricing();
	return (
		<ul className={isPublic ? "space-y-2.5 [&>li>svg]:hidden" : "space-y-3"}>
			{children}
		</ul>
	);
}

/**
 * A plan card's one-line description. On the public page it reserves three
 * lines from `md` up, so the price blocks and the "Everything in …, plus"
 * rows line up across the cards in a row.
 */
export function PlanDescription({ children }: { children: ReactNode }) {
	const isPublic = useIsPublicPricing();
	return (
		<CardDescription className={isPublic ? "md:min-h-[3lh]" : undefined}>
			{children}
		</CardDescription>
	);
}

/** The marketplace deposit-fee row; a quiet footnote on the public page. */
export function DepositFeeFeature({ fee }: { fee: string }) {
	const isPublic = useIsPublicPricing();
	return (
		<li
			className={cn(
				"flex items-center",
				isPublic && "text-muted-foreground text-xs"
			)}
		>
			<Coins className="mr-2 size-4" />
			<span>{depositFeeLine(fee)}</span>
		</li>
	);
}
