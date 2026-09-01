"use client";

import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import {
	PlanBadge,
	type PlanTier,
	planTierConicGradient,
} from "@ryu/ui/components/plan-badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowLeft,
	Bot,
	Calendar,
	ChevronDown,
	Cloud,
	Coins,
	Cpu,
	Download,
	Key,
	Loader2,
	Mail,
	Monitor,
	Scale,
	Server,
	Shield,
	Star,
	Users,
	Wrench,
	Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import {
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import {
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

export {
	BUSINESS_ADDITIONAL_SEAT_USD,
	BUSINESS_BASE_MONTHLY_USD,
	BUSINESS_CREDIT_BUNDLE_SIZE,
	BUSINESS_INCLUDED_CREDIT_USD,
	BUSINESS_INCLUDED_SEATS,
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
export {
	HOSTED_AGENT_SLIDER_MAX,
	normalizeTeamsSeatCount,
	TEAMS_MAX_SEATS,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

export type PricingPlanSlug =
	| "lifetime"
	| "marketplace-membership-monthly"
	| "marketplace-membership-yearly"
	| "pro-monthly"
	| "pro-yearly"
	| "max-monthly"
	| "max-yearly"
	| "teams-monthly"
	| "teams-yearly"
	| "business-monthly"
	| "business-yearly"
	| "business-agents-monthly"
	| "enterprise-agents-monthly"
	// Ryu Cloud hosting tiers, e.g. "cloud-base" / "cloud-2x" / "cloud-3x". The
	// exact ids come from the tier catalog (`@ryu/auth/lib/cloud-tiers`), injected
	// by the page; this stays presentational.
	| `cloud-${string}`;

export type CurrentPricingPlan =
	| "desktop-license"
	| "marketplace-membership"
	| "pro"
	| "max"
	| "teams"
	| "business";

/**
 * Display shape for a Ryu Cloud hosting tier row (injected by the page). Specs +
 * price come from the live Hetzner catalog with a markup, but the USER never sees
 * Hetzner/CX/CPX names — only CPU / RAM / SSD + a perf label. `monthlyAddUsd` is
 * the cost of a paid add-on (0 for the generic base candidate, flagged by
 * `includedWithMax`). The server resolves the exact plan and region.
 */
export interface CloudHostingTier {
	readonly cores: number;
	readonly diskGb: number;
	/** Canonical tier id (BASE / 2X / 3X). */
	readonly id: string;
	/** True for the generic base candidate; retained for compatibility. */
	readonly includedWithMax: boolean;
	/** True when this exact tier is included by the selected plan and region. */
	readonly includedWithPlan?: boolean;
	readonly memoryGb: number;
	/** Monthly add-on price (USD). 0 for the generic included-base candidate. */
	readonly monthlyAddUsd: number;
	readonly name: string;
	/** User-facing performance label ("Cost-optimized" | "Performance"). */
	readonly perfLabel: string;
	/** The checkout slug, e.g. "cloud-2x". BASE has no standalone checkout. */
	readonly slug: PricingPlanSlug;
}

const noop = () => {
	// presentational default; the live page injects real handlers
};

/* -------------------------------------------------------------------------- *
 * Advertised list prices, in whole USD per month.
 *
 * These MIRROR `PLAN_MONTHLY_PRICE_MICRO_USD` in `@ryu/auth/lib/plans` (the
 * billing source of truth). They are duplicated here — not imported — because
 * `@ryu/blocks` is presentational and must not take a dependency on the auth /
 * control-plane package; the desktop paywall and the storyboard render these
 * same cards without a billing client. Change a price in `plans.ts` and change
 * it here in the same commit.
 * -------------------------------------------------------------------------- */
export const PRO_MONTHLY_USD = 49;
/** The recurring A Major Pass price per user. */
export const MARKETPLACE_PASS_MONTHLY_USD = 20;
/** A Major Pass yearly price per user (two months free). */
export const MARKETPLACE_PASS_YEARLY_USD = 200;
/**
 * Max is the original hidden individual plan price. The public business shelf
 * uses the separate Teams automation offer below.
 */
export const MAX_MONTHLY_USD = 99;
/**
 * Teams is a native member-seat offer: $50/member/month with a five-seat
 * minimum ($250 floor). The old agent names remain as compatibility exports for
 * internal callers that have not migrated to the hosted card yet.
 */
export const TEAMS_MONTHLY_USD = 250;
/** @deprecated Use {@link TEAMS_MONTHLY_USD}. */
export const TEAMS_MONTHLY_PER_SEAT_USD = 50;
/**
 * Max is SINGLE-SEAT. The constant stays at 1 (and the card shows no seat
 * stepper) because Max used to be seat-scalable, which put two multi-seat
 * business plans side by side differing only in credit volume. Multi-seat is
 * Teams' job.
 */
export const MAX_MIN_SEATS = 1;

/* -------------------------------------------------------------------------- *
 * Legacy plan-card included AI usage, in whole USD per month. Hosted business
 * automation uses the dynamic helpers below.
 *
 * The base values are duplicated here because this presentational package does
 * not depend on the control-plane catalog. Hosted cards use
 * `hostedAgentIncludedCreditUsd`, so the Teams pool grows in five-seat bundles
 * while its member-seat quantity changes.
 * -------------------------------------------------------------------------- */
export const PRO_INCLUDED_USD = 15;
export const MAX_INCLUDED_USD = 30;
export const TEAMS_INCLUDED_USD = 50;
/** Current Teams credit grant: one $50 pool for each five billed seats. */
export const TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE = 5;
export const TEAMS_INCLUDED_PER_BUNDLE_USD = 50;
/** @deprecated Use {@link TEAMS_INCLUDED_USD}. */
export const TEAMS_INCLUDED_PER_SEAT_USD = TEAMS_INCLUDED_USD;

/**
 * Hosted business-automation prices. These mirror
 * `@ryu/auth/lib/agent-plans` without making this presentational package depend
 * on the control-plane catalog.
 */
export type HostedAgentPricingPlanId = "teams" | "business" | "pro" | "max";

export const PRO_AGENT_INCLUDED = 5;
export const PRO_AGENT_BASE_USD = 250;
export const PRO_AGENT_STANDARD_USD = 50;
export const PRO_AGENT_PACK_USD = 40;
/** Shared monthly AI-credit grant added for each paid Pro agent after the floor. */
export const PRO_INCLUDED_PER_ADDITIONAL_AGENT_USD = 25;
export const PRO_AGENT_MAX_ORG_MEMBERS = 50;
export const MAX_AGENT_INCLUDED = 50;
export const MAX_AGENT_BASE_USD = 2500;
export const MAX_AGENT_STANDARD_USD = 30;
export const MAX_AGENT_PACK_USD = 25;
/** Shared monthly AI-credit grant added for each paid Max agent after the floor. */
export const MAX_INCLUDED_PER_ADDITIONAL_AGENT_USD = 5;
/** Public business offer: the Teams card owns the new five-agent price. */
export const TEAMS_AGENT_INCLUDED = 5;
export const TEAMS_AGENT_BASE_USD = 250;
export const TEAMS_AGENT_STANDARD_USD = 50;
export const TEAMS_AGENT_PACK_USD = 40;
export const TEAMS_INCLUDED_PER_ADDITIONAL_AGENT_USD = 25;
export const HOSTED_AGENT_BUNDLE_SIZE = 5;
export const HOSTED_AGENT_SLIDER_MIN = TEAMS_AGENT_INCLUDED;

const normalizeHostedAgentCount = (
	agentCount: number,
	minimum: number
): number => {
	const bounded = Number.isFinite(agentCount)
		? Math.max(minimum, Math.floor(agentCount))
		: minimum;
	return (
		Math.ceil(bounded / HOSTED_AGENT_BUNDLE_SIZE) * HOSTED_AGENT_BUNDLE_SIZE
	);
};

/**
 * Shared monthly AI credits for a hosted organization. Teams owns one pooled
 * organization wallet; the current grant adds $50 for every five billed seats.
 */
export function hostedAgentIncludedCreditUsd(
	planId: HostedAgentPricingPlanId,
	agentCount: number
): number {
	if (planId === "business") {
		return businessIncludedCreditUsd(agentCount);
	}
	const isTeams = planId === "teams";
	if (isTeams) {
		const seats = normalizeTeamsSeatCount(agentCount);
		return (
			Math.ceil(seats / TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE) *
			TEAMS_INCLUDED_PER_BUNDLE_USD
		);
	}
	const floor = isTeams ? TEAMS_AGENT_INCLUDED : PRO_AGENT_INCLUDED;
	const count = normalizeHostedAgentCount(agentCount, floor);
	if (planId === "pro") {
		return (
			PRO_INCLUDED_USD +
			Math.max(0, count - PRO_AGENT_INCLUDED) *
				PRO_INCLUDED_PER_ADDITIONAL_AGENT_USD
		);
	}
	const maxCount = normalizeHostedAgentCount(agentCount, MAX_AGENT_INCLUDED);
	return (
		MAX_INCLUDED_USD +
		Math.max(0, maxCount - MAX_AGENT_INCLUDED) *
			MAX_INCLUDED_PER_ADDITIONAL_AGENT_USD
	);
}

/** The monthly price at a contracted hosted-agent count. */
export function hostedAgentMonthlyPriceUsd(
	planId: HostedAgentPricingPlanId,
	agentCount: number
): number {
	if (planId === "business") {
		return businessMonthlyPriceUsd(agentCount);
	}
	if (planId === "teams") {
		return TEAMS_MONTHLY_PER_SEAT_USD * normalizeTeamsSeatCount(agentCount);
	}
	const count = normalizeHostedAgentCount(
		agentCount,
		planId === "pro" ? PRO_AGENT_INCLUDED : MAX_AGENT_INCLUDED
	);
	if (planId === "pro") {
		const throughTen = Math.max(0, Math.min(count, 10) - PRO_AGENT_INCLUDED);
		const afterTen = Math.max(0, count - 10);
		return (
			PRO_AGENT_BASE_USD +
			throughTen * PRO_AGENT_STANDARD_USD +
			afterTen * PRO_AGENT_PACK_USD
		);
	}

	const throughHundred = Math.max(0, Math.min(count, 100) - MAX_AGENT_INCLUDED);
	const afterHundred = Math.max(0, count - 100);
	return (
		MAX_AGENT_BASE_USD +
		throughHundred * MAX_AGENT_STANDARD_USD +
		afterHundred * MAX_AGENT_PACK_USD
	);
}

/** Recommend the better-value shelf at the selected agent volume. */
export function hostedAgentRecommendedPlan(
	agentCount: number
): HostedAgentPricingPlanId {
	const count = normalizeHostedAgentCount(agentCount, HOSTED_AGENT_SLIDER_MIN);
	const teamsPrice = hostedAgentMonthlyPriceUsd("teams", count);
	const maxPrice = hostedAgentMonthlyPriceUsd(
		"max",
		Math.max(count, MAX_AGENT_INCLUDED)
	);
	return maxPrice <= teamsPrice ? "max" : "teams";
}

/**
 * Legacy seat-volume helpers retained for compatibility with older card
 * consumers. The public Teams automation offer is priced in member seats; the
 * old volume helpers remain only for compatibility callers.
 */
export const TEAMS_VOLUME_TIERS: readonly {
	minSeats: number;
	percent: number;
}[] = [
	{ minSeats: 10, percent: 5 },
	{ minSeats: 25, percent: 10 },
	{ minSeats: 50, percent: 15 },
];

/**
 * The old per-seat price at `seats`, volume discount applied.
 *
 * THIS MUST EXIST, and its absence was a bug: the card rendered the volume
 * ladder as a NOTE while `PriceBlock` still multiplied the LIST seat price by
 * the seat count. At 25 seats the page quoted $1,225/mo against the $1,102.50
 * Polar actually charges — the page overstating by $122.50/mo, which is the same
 * class of page-vs-checkout disagreement as a page advertising one unit while
 * checkout bills another. A discount nobody sees until the invoice is worse
 * than no discount.
 *
 * Rounded to whole cents to match `seatPriceUsd` in `@ryu/auth/lib/seat-tiers`,
 * which is what the provisioning script writes into Polar's native seat tiers.
 */
export function teamsSeatPriceUsd(listUsd: number, seats: number): number {
	let percent = 0;
	for (const tier of TEAMS_VOLUME_TIERS) {
		if (seats >= tier.minSeats) {
			percent = tier.percent;
		}
	}
	return Math.round(listUsd * (1 - percent / 100) * 100) / 100;
}

/** The volume discount in force at `seats`, as a percentage (0 when none). */
export function teamsVolumePercent(seats: number): number {
	let percent = 0;
	for (const tier of TEAMS_VOLUME_TIERS) {
		if (seats >= tier.minSeats) {
			percent = tier.percent;
		}
	}
	return percent;
}

/** Annual billing gives two months free (pay for 10 of 12 months). */
const FREE_MONTHS_ON_ANNUAL = 2;
const MONTHS_PER_YEAR = 12;
/** Paid months in an annual term, once the two free months are taken off. */
const PAID_MONTHS_ON_ANNUAL = MONTHS_PER_YEAR - FREE_MONTHS_ON_ANNUAL;

/**
 * The billed monthly figure a recurring plan advertises. On the yearly toggle
 * this is the per-month *equivalent* of the annual price (two months free, i.e.
 * billed for 10 of 12 months); on monthly it is the list price. Anchoring on the
 * smaller monthly number is the standard SaaS psychology play. With monthly
 * $49/$99 this lands the annual totals on $490/$990 (Pro/Max), matching the
 * Polar yearly prices.
 */
export function effectiveMonthlyPrice(
	monthly: number,
	isYearly: boolean
): number {
	return isYearly
		? (monthly * PAID_MONTHS_ON_ANNUAL) / MONTHS_PER_YEAR
		: monthly;
}

/** The true annual total for a plan billed yearly (two months free). */
export function annualTotalPrice(monthly: number): number {
	return monthly * PAID_MONTHS_ON_ANNUAL;
}

/**
 * The price block for a recurring plan. Always shows the whole-dollar monthly
 * list price with a "/mo" suffix, with the true annual total spelled out beneath.
 *
 * The headline is always the PER-PERSON price — the number the plan is
 * advertised at — so the comparison across cards stays apples-to-apples; the
 * multiplied total for the chosen seat count is spelled out underneath so the
 * buyer still sees what they will actually pay. `perSeat` only controls the
 * "/seat" suffix (Teams is advertised per seat; Max is advertised at a flat
 * $99/mo), and is independent of `seats`.
 */
function PriceBlock({
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
	const annualTotal = annualTotalPrice(monthly);
	const perMonth = monthly;
	const seat = perSeat ? "/seat" : "";
	// Only more than one seat has a total worth spelling out; at one seat the
	// total IS the headline.
	const showSeatTotal = !totalMonthly && seats > 1;
	const seatTotal = perMonth * seats;
	const seatAnnualTotal = annualTotal * seats;
	const priceAmount = (value: number, className: string) => (
		<NumberTicker className={className} prefix="$" value={Math.round(value)} />
	);
	return (
		<>
			<div className="mb-1 flex items-baseline">
				{priceAmount(
					perMonth,
					"font-heading font-semibold text-4xl tabular-nums"
				)}
				<span className="ml-1 text-muted-foreground">{`${seat}/mo`}</span>
			</div>
			{/* The seat total and the annual total spin like the headline rather
			    than snapping. They move for the SAME reasons it does — the yearly
			    toggle and the seat stepper — so a static number beside a spinning
			    one reads as the static one having failed to update. */}
			{showSeatTotal ? (
				<p className="mb-1 flex items-baseline font-medium text-sm">
					{priceAmount(seatTotal, "font-heading tabular-nums")}
					<span className="ml-1">/mo for {seats} seats</span>
				</p>
			) : null}
			{isYearly ? (
				<p className="mb-6 flex items-baseline text-muted-foreground text-xs">
					<span className="mr-1">Billed</span>
					{priceAmount(
						showSeatTotal ? seatAnnualTotal : annualTotal,
						"font-heading tabular-nums"
					)}
					<span className="ml-1">
						{showSeatTotal
							? `per year for ${seats} seats`
							: `${seat ? "per seat " : ""}per year, two months free`}
					</span>
				</p>
			) : (
				<p className="mb-6 text-muted-foreground text-xs">
					{perSeat
						? "Billed monthly per seat, cancel anytime"
						: "Billed monthly, cancel anytime"}
				</p>
			)}
		</>
	);
}

/**
 * Which public shelf is rendered. Individual includes the local desktop license,
 * Pro, Max, and A Major Pass; the business shelf owns Teams, Business, and
 * Enterprise.
 */
export type PricingAudience = "business" | "individual";

/** Which plans each audience sees, and in which order. */
export const PRICING_AUDIENCE_PLANS = {
	business: ["teams", "business", "enterprise"],
	individual: ["desktop-license", "pro", "max", "marketplace-membership"],
} as const;

/** Where the customer runs Ryu — the outermost pricing choice. */
export type PricingDeployment = "platform" | "self-hosted";

/**
 * THE DEPLOYMENT SWITCH — platform vs self-hosted.
 *
 * This is the page's large, label-only text switch. It sits above the two
 * pricing controls below it: audience uses `pills-lg`, while billing stays on
 * the compact `pills` treatment. The two lower controls disappear entirely on
 * the self-hosted side because there is no seat billing or audience split.
 */
export function PricingDeploymentToggle({
	deployment = "platform",
	onDeploymentChange = noop,
}: {
	deployment?: PricingDeployment;
	onDeploymentChange?: (deployment: PricingDeployment) => void;
}) {
	return (
		<div className="mx-auto mb-8 flex justify-center">
			<Tabs
				aria-label="Deployment"
				onValueChange={(value) =>
					onDeploymentChange(value as PricingDeployment)
				}
				value={deployment}
			>
				<TabsList className="min-w-max" manageLayout={false} variant="text">
					<TabsTrigger className="text-xl!" value="platform">
						Ryu Platform
					</TabsTrigger>
					<TabsTrigger className="text-xl!" value="self-hosted">
						Self-Hosted
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	);
}

/**
 * The individual / business audience switch. Sits ABOVE the monthly/yearly
 * toggle: it changes WHICH plans exist, where the billing toggle only changes
 * how the visible ones are billed, so the wider choice is the outer one.
 *
 * Both this and the billing toggle live INSIDE the platform branch — see
 * {@link PricingDeploymentToggle} for why they are hidden rather than disabled
 * on the self-hosted side.
 */
export function PricingAudienceToggle({
	audience = "individual",
	onAudienceChange = noop,
}: {
	audience?: PricingAudience;
	onAudienceChange?: (audience: PricingAudience) => void;
}) {
	return (
		<div className="mb-4 flex justify-center">
			<Tabs
				onValueChange={(val) => onAudienceChange(val as PricingAudience)}
				value={audience}
			>
				<TabsList className="min-w-max" manageLayout={false} variant="pills-lg">
					<TabsTrigger className="text-base" value="individual">
						Individual
					</TabsTrigger>
					<TabsTrigger className="text-base" value="business">
						Teams &amp; Enterprise
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	);
}

/** The monthly/yearly billing period toggle. */
export function PricingBillingToggle({
	isYearly = false,
	onToggleYearly = noop,
}: {
	isYearly?: boolean;
	onToggleYearly?: (yearly: boolean) => void;
}) {
	return (
		<div className="mb-8 flex justify-center">
			<Tabs
				onValueChange={(val) => onToggleYearly(val === "yearly")}
				value={isYearly ? "yearly" : "monthly"}
			>
				<TabsList
					className="min-w-max p-0"
					manageLayout={false}
					variant="default"
				>
					<TabsTrigger
						className="data-active:bg-foreground data-active:text-background! dark:data-active:bg-foreground dark:data-active:text-background!"
						value="monthly"
					>
						Monthly
					</TabsTrigger>
					<TabsTrigger
						className="data-active:bg-foreground data-active:text-background! dark:data-active:bg-foreground dark:data-active:text-background! [&_span]:text-primary data-active:[&_span]:text-background! dark:data-active:[&_span]:text-background!"
						value="yearly"
					>
						Yearly
						<span className="ml-1.5 font-medium text-xs">2 months free</span>
					</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	);
}

/**
 * Apple-style expandable "add hosted compute" panel, nested inside a plan card
 * (Max and Teams). Collapsed by default; expands to reveal the Ryu Cloud
 * hosting ladder. The BASE node ships free with the plan (shown as "Included",
 * never a checkout); the 2X/3X performance tiers are paid add-ons priced on top
 * of the plan, each with its own checkout (separate monthly billing — the merge
 * is purely visual). Renders nothing when no tiers are supplied. `planLabel`
 * names the host plan in the copy.
 */
function CloudUpgradePanel({
	tiers,
	loadingPlan,
	onCheckout,
}: {
	tiers: readonly CloudHostingTier[];
	loadingPlan: PricingPlanSlug | null;
	onCheckout: (slug: PricingPlanSlug) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	if (tiers.length === 0) {
		return null;
	}

	return (
		<div className="mt-6 border-t pt-4">
			<button
				aria-expanded={expanded}
				className="flex w-full items-center justify-between gap-2 text-left font-medium text-sm"
				onClick={() => setExpanded((prev) => !prev)}
				type="button"
			>
				<span className="flex items-center gap-2">
					<Server className="size-4" />
					Run your AI in the cloud
				</span>
				<ChevronDown
					className={
						expanded
							? "size-4 rotate-180 transition-transform"
							: "size-4 transition-transform"
					}
				/>
			</button>
			<p className="mt-1 text-muted-foreground text-xs">
				Included managed server, upgrade for more performance, add-ons billed
				monthly
			</p>
			<AnimatePresence initial={false}>
				{expanded ? (
					<motion.ul
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						initial={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.24, ease: "easeOut" }}
					>
						{tiers.map((tier) => {
							const specs = `${tier.cores} vCPU, ${tier.memoryGb} GB RAM, and ${tier.diskGb} GB SSD`;
							// BASE ships free with the plan: shown, never a checkout.
							const isIncluded = tier.includedWithPlan ?? tier.includedWithMax;
							if (isIncluded) {
								return (
									<li key={tier.slug}>
										<div className="mt-3 flex w-full items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-left">
											<Cloud className="size-4 shrink-0 text-primary" />
											<span className="flex-1">
												<span className="block font-medium text-sm">
													{tier.name} is {tier.perfLabel}
												</span>
												<span className="block text-muted-foreground text-xs">
													{specs}
												</span>
											</span>
											<span className="shrink-0 font-semibold text-primary text-sm">
												Included
											</span>
										</div>
									</li>
								);
							}
							const isLoading = loadingPlan === tier.slug;
							return (
								<li key={tier.slug}>
									<button
										className="mt-3 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary disabled:opacity-60"
										disabled={isLoading}
										onClick={() => onCheckout(tier.slug)}
										type="button"
									>
										<Cpu className="size-4 shrink-0 text-primary" />
										<span className="flex-1">
											<span className="block font-medium text-sm">
												{tier.name} is {tier.perfLabel}
											</span>
											<span className="block text-muted-foreground text-xs">
												{specs}
											</span>
										</span>
										<span className="shrink-0 text-right">
											{isLoading ? (
												<Loader2 className="size-4 animate-spin" />
											) : (
												<span className="font-heading font-semibold text-sm tabular-nums">
													${tier.monthlyAddUsd} per month
												</span>
											)}
										</span>
									</button>
								</li>
							);
						})}
					</motion.ul>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/**
 * Wraps a plan card in a 2px gradient border. The legacy Pro card keeps its
 * always-on animated conic sweep (`.t-pro-card-border`). Hosted pricing passes
 * `isRecommended` explicitly so only the recommended card keeps the same
 * conic ring visible; the other card returns to the static default border and
 * only animates on hover (`.t-card-border-spin` + {@link planTierConicGradient}).
 */
function PricingCardBorder({
	isRecommended = false,
	variant,
	children,
}: {
	isRecommended?: boolean;
	variant: PlanTier;
	children: ReactNode;
}) {
	const showHighlightedBorder = isRecommended || variant === "pro";
	if (variant === "pro" && showHighlightedBorder) {
		return (
			<div
				className={cn(
					"t-pro-card-border relative rounded-[calc(var(--radius-4xl)+2px)] p-[2px]"
				)}
			>
				<Card className="relative flex h-full flex-col border-transparent">
					{children}
				</Card>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"group relative rounded-[calc(var(--radius-4xl)+2px)] bg-border p-[2px] dark:bg-transparent"
			)}
		>
			<div
				aria-hidden
				className={cn(
					"t-card-border-spin pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-500 ease-out",
					showHighlightedBorder
						? "opacity-100"
						: "opacity-0 group-hover:opacity-100"
				)}
				style={{ backgroundImage: planTierConicGradient(variant) }}
			/>
			<Card className="relative flex h-full flex-col border-transparent">
				{children}
			</Card>
		</div>
	);
}

/** Shared props every individual plan card accepts. */
interface PlanCardProps {
	currentPlan?: CurrentPricingPlan | null;
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
}

/**
 * Extra props a SEAT-BASED plan card accepts (Teams, Max). `minSeats` mirrors
 * the plan catalog's `seatModel.minSeats` and is injected by the page — the
 * blocks package is presentational and deliberately does not depend on
 * `@ryu/auth`. The seat stepper renders only when `onSeatsChange` is supplied,
 * so read-only surfaces keep their current single-seat rendering.
 */
interface SeatPlanCardProps extends PlanCardProps {
	cloudTiers?: readonly CloudHostingTier[];
	minSeats?: number;
	onSeatsChange?: (seats: number) => void;
	seats?: number;
}

interface MarketplacePassPlanCardProps extends PlanCardProps {
	isYearly?: boolean;
}

/** The footer CTA shared by every plan card (current / processing / label). */
function PlanCta({
	isCurrent,
	isLoading,
	label,
	onClick,
	variant,
}: {
	isCurrent: boolean;
	isLoading: boolean;
	label: string;
	onClick: () => void;
	variant?: "outline";
}) {
	return (
		<Button
			className="w-full"
			disabled={isCurrent}
			loading={isLoading}
			onClick={onClick}
			variant={variant}
		>
			{isCurrent ? "Current plan" : isLoading ? "Processing…" : label}
		</Button>
	);
}

/** Keeps inherited entitlements visually separate from a plan's own features. */
function IncludedPlanBanner({ plan }: { plan: string }) {
	return (
		<div className="mb-6 border-border/70 border-b pb-3">
			<p className="flex items-center gap-2 text-foreground text-sm">
				<ArrowLeft
					aria-hidden="true"
					className="size-4 shrink-0 text-foreground"
				/>
				<span>Everything in {plan}, plus</span>
			</p>
		</div>
	);
}

/** Local desktop license card — shown on the Individual shelf and desktop paywall. */
export function LifetimePlanCard({
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: PlanCardProps) {
	const isCurrent = currentPlan === "desktop-license";
	return (
		<PricingCardBorder variant="desktop-license">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Local Desktop
					<PlanBadge label="One-time" plan="desktop-license" size="md" />
				</CardTitle>
				<CardDescription>
					Ryu runs on your own hardware, and hosted business automation is
					separate
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 flex items-baseline gap-2">
					<NumberTicker
						className="font-heading font-semibold text-4xl text-primary tabular-nums"
						prefix="$"
						value={129}
					/>
					<span className="font-heading text-muted-foreground text-xl tabular-nums line-through">
						$200
					</span>
					<span className="ml-1 text-muted-foreground">once</span>
				</div>
				<p className="mb-6 font-medium text-primary text-xs">
					Launch price with 36% savings
				</p>
				<ul className="space-y-3">
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>You can run local agents and workflows on your computer</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>You can use your own keys for cloud AI if you want</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>
							Hosted agents, managed servers, and monthly credits are not
							included
						</span>
					</li>
					<li className="flex items-center">
						<Calendar className="mr-2 size-4" />
						<span>One year of updates is included</span>
					</li>
					<li className="flex items-center">
						<Star className="mr-2 size-4" />
						<span>The local trial lasts 7 days and needs no card</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={loadingPlan === "lifetime"}
					label="Get desktop license"
					onClick={() => onCheckout("lifetime")}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** A Major Pass: recurring access to supported paid Marketplace apps. */
export function MarketplacePassPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: MarketplacePassPlanCardProps) {
	const isCurrent = currentPlan === "marketplace-membership";
	const monthlyTotal = MARKETPLACE_PASS_MONTHLY_USD;
	return (
		<PricingCardBorder variant="marketplace-membership">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					A Major Pass
					<PlanBadge
						label="A Major Pass"
						plan="marketplace-membership"
						size="md"
					/>
				</CardTitle>
				<CardDescription>
					One pass gives one individual user access to supported paid
					Marketplace apps
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-6">
					<div>
						<PriceBlock
							isYearly={isYearly}
							monthly={monthlyTotal}
							totalMonthly
						/>
						<p className="-mt-4 text-muted-foreground text-xs">
							One individual user is included
						</p>
					</div>
				</div>
				<ul className="space-y-3">
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>
							One person can access all supported paid Marketplace apps
						</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>The pass is for one individual user</span>
					</li>
					<li className="flex items-center">
						<Star className="mr-2 size-4" />
						<span>You can see the ticket marker before you install</span>
					</li>
					<li className="flex items-center">
						<Calendar className="mr-2 size-4" />
						<span>
							You can cancel anytime, and access lasts through your paid period
						</span>
					</li>
					<li className="flex items-center text-muted-foreground">
						<Cloud className="mr-2 size-4" />
						<span>
							Managed AI, cloud servers, and monthly credits are not included
						</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={
						loadingPlan ===
						(isYearly
							? "marketplace-membership-yearly"
							: "marketplace-membership-monthly")
					}
					label="Get A Major Pass"
					onClick={() =>
						onCheckout(
							isYearly
								? "marketplace-membership-yearly"
								: "marketplace-membership-monthly"
						)
					}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** Pro plan card — the highlighted managed plan (animated gradient border). */
export function ProPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
}: PlanCardProps) {
	const isCurrent = currentPlan === "pro";
	const isLoading =
		loadingPlan === "pro-monthly" || loadingPlan === "pro-yearly";

	return (
		<PricingCardBorder variant="pro">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Pro Plan
					<PlanBadge plan="pro" size="md" />
				</CardTitle>
				<CardDescription>
					Managed AI for one person. Bring a shared workspace to Teams
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={PRO_MONTHLY_USD} />
				<ul className="space-y-3">
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>1 personal workspace</span>
					</li>
					<li className="flex items-center">
						<Download className="mr-2 size-4" />
						<span>Full app on all your devices</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Personal chats, agents, and spaces</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>300+ cloud AI models</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${PRO_INCLUDED_USD}
							</span>
							/month AI usage included
						</span>
					</li>
					<li className="flex items-center">
						<Zap className="mr-2 size-4" />
						<span>Guided setup for your personal workspace</span>
					</li>
					<li className="flex items-center">
						<Monitor className="mr-2 size-4" />
						<span>Run AI on your computer</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							Agent Inboxes, 10,000 monthly sends, and 20 GB mail storage
						</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>16.5% deposit fee ($2.75 minimum)</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>20 GB of space storage</span>
					</li>
					{/* A qualifying hosted plan receives one plan- and region-specific
					    managed server. The server is the authority for the exact shape. */}
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>
							Managed server with 2 vCPU, 4 GB RAM, and 40 GB SSD. Singapore is
							a paid add-on
						</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>Bring your own API keys</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() => onCheckout(isYearly ? "pro-yearly" : "pro-monthly")}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Max plan card — the individual power tier, with the optional Cloud panel.
 *
 * NO SEAT STEPPER: Max is single-seat now. It was seat-scalable, and that is
 * precisely what made the ladder unreadable — a buyer comparing two multi-seat
 * plans had to do arithmetic to discover the cheaper one was also the better
 * one. Teams owns multi-seat.
 *
 * The bullets lead with what a TOP-UP CANNOT BUY (machine, mail, deposit rate),
 * because the credit line alone no longer justifies the jump and pretending
 * otherwise is how the old $200 tier became unsellable.
 */
export function MaxPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
}: SeatPlanCardProps) {
	const isCurrent = currentPlan === "max";
	const isLoading =
		loadingPlan === "max-monthly" || loadingPlan === "max-yearly";
	// `seats` / `minSeats` / `onSeatsChange` are accepted and IGNORED rather than
	// removed from the prop type: the page still passes them, and dropping them
	// from the signature would break the call site for a card that simply has no
	// seat dimension any more. They are inert here on purpose.
	return (
		<PricingCardBorder variant="max">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Max Plan
					<PlanBadge plan="max" size="md" />
				</CardTitle>
				<CardDescription>
					More throughput for one person. Shared agent deployments belong in
					Teams
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock isYearly={isYearly} monthly={MAX_MONTHLY_USD} />
				<IncludedPlanBanner plan="Pro" />
				<ul className="space-y-3">
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>1 personal workspace</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>
							Managed server with 4 vCPU, 8 GB RAM, and 80 GB SSD. Singapore is
							a paid add-on
						</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>16% deposit fee ($2.75 minimum)</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>Higher throughput for personal agents and workflows</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${MAX_INCLUDED_USD}
							</span>
							/month AI usage included
						</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>
							Agent Inboxes, 100,000 monthly sends, and 100 GB storage
						</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Priority support</span>
					</li>
				</ul>
				<CloudUpgradePanel
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					tiers={cloudTiers}
				/>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() => onCheckout(isYearly ? "max-yearly" : "max-monthly")}
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Compatibility Teams plan card with the optional Cloud panel. Public hosted
 * pricing uses `HostedAgentPlanCard`; this card is still rendered by the
 * desktop paywall and must therefore show the same five-seat floor and member
 * seat price.
 */
export function TeamsPlanCard({
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	cloudTiers = [],
}: SeatPlanCardProps) {
	const isCurrent = currentPlan === "teams";
	const isLoading =
		loadingPlan === "teams-monthly" || loadingPlan === "teams-yearly";
	return (
		<PricingCardBorder variant="teams">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Teams
					<PlanBadge plan="teams" size="md" />
				</CardTitle>
				<CardDescription>
					A shared deployment for agents your team can run and oversee
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock
					isYearly={isYearly}
					monthly={TEAMS_MONTHLY_PER_SEAT_USD}
					perSeat
					seats={TEAMS_MIN_SEATS}
				/>
				<ul className="space-y-3">
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>5 seats included</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>${TEAMS_INCLUDED_USD}/month shared AI credits</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Access controls, spend controls, and audit history</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Guided setup for agent workflows</span>
					</li>
					<li className="flex items-center">
						<Mail className="mr-2 size-4" />
						<span>100,000 monthly sends and 20 GB mail storage</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>Managed server with 8 vCPU, 16 GB RAM, and 160 GB SSD</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>16% deposit fee ($2.75 minimum)</span>
					</li>
				</ul>
				<CloudUpgradePanel
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
					tiers={cloudTiers}
				/>
			</CardContent>
			<CardFooter>
				<PlanCta
					isCurrent={isCurrent}
					isLoading={isLoading}
					label="Upgrade"
					onClick={() =>
						onCheckout(isYearly ? "teams-yearly" : "teams-monthly")
					}
					variant="outline"
				/>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** Hosted business-automation plan card. Pro/Max remain compatibility cards. */
export function HostedAgentPlanCard({
	agentCount,
	currentPlan = null,
	isYearly = false,
	isRecommended = false,
	loadingPlan = null,
	onCheckout = noop,
	planId,
}: {
	agentCount: number;
	currentPlan?: CurrentPricingPlan | null;
	isYearly?: boolean;
	isRecommended?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	onCheckout?: (slug: PricingPlanSlug) => void;
	planId: HostedAgentPricingPlanId;
}) {
	const isTeams = planId === "teams";
	const isBusiness = planId === "business";
	const isPro = planId === "pro";
	const minAgents =
		isTeams || isBusiness
			? TEAMS_AGENT_INCLUDED
			: isPro
				? PRO_AGENT_INCLUDED
				: MAX_AGENT_INCLUDED;
	const effectiveAgentCount =
		isTeams || isBusiness
			? normalizeTeamsSeatCount(agentCount)
			: normalizeHostedAgentCount(agentCount, minAgents);
	const exceedsTeamsSelfServe =
		(isTeams || isBusiness) && effectiveAgentCount > TEAMS_MAX_SEATS;
	// Once the slider crosses the self-serve ceiling, keep the Teams card as a
	// clear maximum anchor rather than showing a price for a quantity it cannot
	// sell. Enterprise owns the selected 51+ quantity and the CTA below.
	const displayAgentCount = exceedsTeamsSelfServe
		? TEAMS_MAX_SEATS
		: effectiveAgentCount;
	const monthlyPrice = hostedAgentMonthlyPriceUsd(
		planId,
		isTeams || isBusiness ? displayAgentCount : effectiveAgentCount
	);
	const slug =
		`${planId}-${isYearly ? "yearly" : "monthly"}` as PricingPlanSlug;
	const isCurrent = currentPlan === planId;
	const isLoading = loadingPlan === slug;
	const includedCredits = hostedAgentIncludedCreditUsd(
		planId,
		isTeams || isBusiness ? displayAgentCount : effectiveAgentCount
	);
	const planName = isTeams
		? "Teams"
		: isBusiness
			? "Business"
			: isPro
				? "Pro Plan"
				: "Max Plan";
	const planBadge: PlanTier = isTeams
		? "teams"
		: isBusiness
			? "business"
			: isPro
				? "pro"
				: "max";

	return (
		<PricingCardBorder
			isRecommended={isRecommended}
			variant={
				isTeams ? "teams" : isBusiness ? "business" : isPro ? "pro" : "max"
			}
		>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					{planName}
					<PlanBadge
						label={planName.replace(" Plan", "")}
						plan={planBadge as PlanTier}
						size="md"
					/>
				</CardTitle>
				<CardDescription>
					{isTeams
						? "A shared deployment for agents your team can run and oversee"
						: isBusiness
							? "More capacity for managed agent deployments with your tools and workflows"
							: isPro
								? "Personal Ryu access for running and customising workflows"
								: "Custom capacity, deployment, and governance for your organization"}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<PriceBlock
					isYearly={isYearly}
					monthly={monthlyPrice}
					perSeat={false}
					seats={isTeams || isBusiness ? displayAgentCount : 1}
					totalMonthly={isTeams || isBusiness}
				/>
				{isBusiness ? <IncludedPlanBanner plan="Teams" /> : null}
				<ul className="space-y-3">
					<li className="flex items-center">
						<Bot className="mr-2 size-4" />
						<span>
							{isTeams || isBusiness
								? `${displayAgentCount} seats included`
								: `${effectiveAgentCount} ${effectiveAgentCount === 1 ? "agent" : "agents"} can run a named business process`}
						</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4" />
						<span>
							<span className="font-heading tabular-nums">
								${includedCredits}
							</span>
							/month shared AI credits
						</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>
							{isBusiness
								? "Performance server with 16 vCPU, 32 GB RAM, and 320 GB SSD"
								: isTeams
									? displayAgentCount >= 50
										? "Two managed servers with 8 vCPU, 16 GB RAM, and 160 GB SSD each"
										: "Managed server with 8 vCPU, 16 GB RAM, and 160 GB SSD"
									: isPro
										? "Managed server with 2 vCPU and 4 GB RAM"
										: "Dedicated managed server with 2 vCPU and 8 GB RAM"}
						</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>
							{isTeams || isBusiness
								? "Access controls, spend controls, and audit history"
								: "Spend controls and audit history"}
						</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>
							{isTeams || isBusiness
								? "Guided setup for agent workflows"
								: isPro
									? "Guided setup for your workflows"
									: "White-label delivery and named onboarding support"}
						</span>
					</li>
					{isTeams || isBusiness ? (
						<li className="flex items-center">
							<Coins className="mr-2 size-4" />
							<span>16% deposit fee ($2.75 minimum)</span>
						</li>
					) : null}
				</ul>
			</CardContent>
			<CardFooter>
				{exceedsTeamsSelfServe ? (
					<a
						className={buttonVariants({ className: "w-full" })}
						href="/contact"
					>
						Talk to Enterprise
					</a>
				) : (
					<PlanCta
						isCurrent={isCurrent}
						isLoading={isLoading}
						label={
							isTeams
								? "Start with Teams"
								: isBusiness
									? "Start with Business"
									: isPro
										? "Start with Pro"
										: "Start with Max"
						}
						onClick={() => onCheckout(slug)}
						variant={isTeams || isBusiness || isPro ? undefined : "outline"}
					/>
				)}
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * Enterprise plan — the conversation-led tier beside Teams.
 *
 * The card is intentionally unpriced: procurement, security, onboarding, and
 * deployment are not honest candidates for a public seat calculator.
 *
 * As a card it also does its OTHER job properly: an unpriced option beside a
 * priced one is the anchor that makes the priced one look definite. "Custom"
 * carries no number to compare against, so it can only raise the reference
 * point.
 *
 * No self-serve checkout — the CTA goes to sales.
 */
export function EnterprisePlanCard({
	isRecommended = false,
}: {
	isRecommended?: boolean;
}) {
	return (
		<PricingCardBorder isRecommended={isRecommended} variant="enterprise">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Enterprise
					<PlanBadge label="Enterprise" plan="enterprise" size="md" />
				</CardTitle>
				<CardDescription>
					For organizations that need a governed rollout, custom capacity, or
					deployment terms
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				{/* No NumberTicker here on purpose: "Custom" is not a number, and the
				    absence of one is the point of the tier. */}
				<div className="mb-1 font-semibold text-4xl">Custom</div>
				<p className="mb-6 text-muted-foreground text-xs">
					This is a tailored annual contract for your organization
				</p>
				<IncludedPlanBanner plan="Business" />
				<ul className="space-y-3">
					<li className="flex items-center">
						<Key className="mr-2 size-4" />
						<span>SSO and SCIM provisioning</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4" />
						<span>Audit logs, custom SLA, and DPA</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4" />
						<span>Dedicated or self-hosted deployment</span>
					</li>
					<li className="flex items-center">
						<Cloud className="mr-2 size-4" />
						<span>Choose your data region</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4" />
						<span>Named contact and onboarding</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4" />
						<span>Invoicing, purchase orders, and custom terms</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<a
					className={buttonVariants({
						variant: "outline",
						className: "w-full",
					})}
					href="/contact"
				>
					Contact sales
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * THE LICENCE COPY ON THESE TWO CARDS IS LOAD-BEARING — do not simplify it to
 * "open source" or to a single licence name.
 *
 * Ryu is open-CORE, not uniformly permissive, and the split is exactly what the
 * paid tier sells relief from (`docs/open-core.md` is the source of truth):
 *
 *  - `apps/core` and the SDK/CLI are **Apache-2.0** — permissive, no obligations.
 *  - `apps/gateway` and `crates/gateway/*` are **AGPL-3.0** — and the gateway is
 *    the piece a company actually deploys for routing, firewall, PII/DLP,
 *    budgets and audit. AGPL's network clause means an org that MODIFIES the
 *    gateway and offers it over a network owes those modifications back.
 *  - The desktop, web and identity surfaces are proprietary and are not part of
 *    a self-hosted deployment at all.
 *
 * That AGPL boundary is the commercial-licence lever, and it is a stronger offer
 * than "we'll support you": the paid tier sells an actual alternative licence to
 * an actual obligation. Writing "Apache 2.0 licensed" across the whole product
 * (which is what a competitor with a uniformly-permissive core can truthfully
 * say) would be FALSE here, and a wrong licence claim on a public pricing page is
 * the most expensive error this file can carry.
 *
 * No price is quoted for the licensed tier. There is no per-annum figure to
 * quote — `docs/enterprise-pricing-framework.md` prices contracts case by case.
 */
export function SelfHostedOssCard() {
	return (
		<PricingCardBorder variant="desktop-license">
			<CardHeader>
				<CardTitle className="text-xl">Open source</CardTitle>
				<CardDescription>
					Run the whole engine on your own machines
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 font-heading font-semibold text-4xl tabular-nums">
					$0
				</div>
				<p className="mb-6 text-muted-foreground text-xs">
					Free forever with community support
				</p>
				<ul className="space-y-3">
					<li className="flex items-center">
						<Scale className="mr-2 size-4 shrink-0" />
						<span>The core uses Apache-2.0 and the gateway uses AGPL-3.0</span>
					</li>
					<li className="flex items-center">
						<Bot className="mr-2 size-4 shrink-0" />
						<span>
							Agents, workflows, memory, and tools with no Ryu plan cap
						</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4 shrink-0" />
						<span>Gateway routing, firewall rules, and budgets</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4 shrink-0" />
						<span>You use your own provider keys</span>
					</li>
					<li className="flex items-center">
						<Server className="mr-2 size-4 shrink-0" />
						<span>Nothing leaves your network</span>
					</li>
					<li className="flex items-center">
						<Users className="mr-2 size-4 shrink-0" />
						<span>Community support</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<a
					className={buttonVariants({
						variant: "outline",
						className: "w-full",
					})}
					href="https://docs.ryuhq.com/docs/start-here/getting-started/self-host"
				>
					Read the self-hosting guide
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}

/** The commercial licence: AGPL relief, plus the controls an enterprise needs. */
export function SelfHostedLicensedCard() {
	return (
		<PricingCardBorder variant="enterprise">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					Licensed
					<PlanBadge label="Enterprise" plan="enterprise" size="md" />
				</CardTitle>
				<CardDescription>
					A commercial licence, on your infrastructure
				</CardDescription>
			</CardHeader>
			<CardContent className="flex-1">
				<div className="mb-1 font-semibold text-4xl">Custom</div>
				<p className="mb-6 text-muted-foreground text-xs">
					You pay a flat annual fee with no per-seat or per-token metering
				</p>
				<IncludedPlanBanner plan="open source" />
				<ul className="space-y-3">
					<li className="flex items-center">
						<Scale className="mr-2 size-4 shrink-0" />
						<span>Commercial licence with no AGPL obligations</span>
					</li>
					<li className="flex items-center">
						<Key className="mr-2 size-4 shrink-0" />
						<span>SSO and SCIM provisioning</span>
					</li>
					<li className="flex items-center">
						<Shield className="mr-2 size-4 shrink-0" />
						<span>Audit logs, custom SLA, and DPA</span>
					</li>
					<li className="flex items-center">
						<Cpu className="mr-2 size-4 shrink-0" />
						<span>Air-gapped and offline deployment</span>
					</li>
					<li className="flex items-center">
						<Wrench className="mr-2 size-4 shrink-0" />
						<span>Named support engineer and onboarding</span>
					</li>
					<li className="flex items-center">
						<Coins className="mr-2 size-4 shrink-0" />
						<span>Invoicing, purchase orders, and custom terms</span>
					</li>
				</ul>
			</CardContent>
			<CardFooter>
				<a className={buttonVariants({ className: "w-full" })} href="/contact">
					Talk to us
				</a>
			</CardFooter>
		</PricingCardBorder>
	);
}

/**
 * The self-hosted shelf: two cards, free OSS and the commercial licence.
 *
 * Two columns for two cards, matching the platform shelf's rule that column
 * count tracks card count — a wider grid holding two cards reads as a page that
 * failed to load.
 */
export function SelfHostedPlanGrid() {
	return (
		<div className="mx-auto mb-12 grid max-w-4xl grid-cols-1 gap-8 md:grid-cols-2">
			<SelfHostedOssCard />
			<SelfHostedLicensedCard />
		</div>
	);
}

/**
 * The pricing plans, presentational: the self-serve plans for one AUDIENCE in a
 * grid. The public page uses the business shelf — Teams, Business, and
 * Enterprise. The individual shelf shows the local desktop license, Pro, and
 * Max, with A Major Pass below them. Cloud
 * hosting is NOT here — it lives in the org dashboard (post-auth).
 *
 * The individual shelf is three columns and the organization shelf is three
 * columns. Column count tracks the card count so the local license, two
 * individual managed plans, or the Teams/Business/Enterprise shelf never
 * renders at an accidental quarter-width.
 */
export function PricingPlanGrid({
	audience = "individual",
	hostedAgentCount = HOSTED_AGENT_SLIDER_MIN,
	isYearly = false,
	loadingPlan = null,
	onCheckout = noop,
	currentPlan = null,
	maxSeats,
	onMaxSeatsChange,
	maxMinSeats = MAX_MIN_SEATS,
	seats,
}: {
	/** Which shelf to render — see {@link PRICING_AUDIENCE_PLANS}. */
	audience?: PricingAudience;
	/** Shared contracted automation-agent count for the hosted shelf. */
	hostedAgentCount?: number;
	isYearly?: boolean;
	loadingPlan?: PricingPlanSlug | null;
	/** Seat minimum for Max, from `PLANS.max.seatModel`. */
	maxMinSeats?: number;
	/**
	 * Max's seat count, tracked SEPARATELY from `seats`. Max scales from one seat
	 * and is advertised at a flat monthly price, so seeding it from the Teams
	 * minimum would open the page showing the flagship plan at two seats.
	 */
	maxSeats?: number;
	onCheckout?: (slug: PricingPlanSlug) => void;
	onHostedAgentCountChange?: (agentCount: number) => void;
	/** Supply to turn on Max's seat stepper. */
	onMaxSeatsChange?: (seats: number) => void;
	/** Supply to turn on the Teams seat stepper. */
	onSeatsChange?: (seats: number) => void;
	currentPlan?: CurrentPricingPlan | null;
	/** The Teams seat count; ignored when `onSeatsChange` is absent. */
	seats?: number;
	/** Seat minimum for Teams, from `PLANS.teams.seatModel`. */
	teamsMinSeats?: number;
}) {
	if (audience === "individual") {
		return (
			<div className="mx-auto mb-12 grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-3">
				<LifetimePlanCard
					currentPlan={currentPlan}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
				<ProPlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					onCheckout={onCheckout}
				/>
				<MaxPlanCard
					currentPlan={currentPlan}
					isYearly={isYearly}
					loadingPlan={loadingPlan}
					minSeats={maxMinSeats}
					onCheckout={onCheckout}
					onSeatsChange={onMaxSeatsChange}
					seats={maxSeats ?? maxMinSeats}
				/>
			</div>
		);
	}
	const selectedSeats = normalizeTeamsSeatCount(seats ?? hostedAgentCount);

	return (
		<div className="mx-auto mb-12 grid max-w-7xl grid-cols-1 gap-8 md:grid-cols-3">
			<HostedAgentPlanCard
				agentCount={selectedSeats}
				currentPlan={currentPlan}
				isRecommended={false}
				isYearly={isYearly}
				loadingPlan={loadingPlan}
				onCheckout={onCheckout}
				planId="teams"
			/>
			<HostedAgentPlanCard
				agentCount={selectedSeats}
				currentPlan={currentPlan}
				isRecommended={selectedSeats <= TEAMS_MAX_SEATS}
				isYearly={isYearly}
				loadingPlan={loadingPlan}
				onCheckout={onCheckout}
				planId="business"
			/>
			<EnterprisePlanCard isRecommended={selectedSeats > TEAMS_MAX_SEATS} />
		</div>
	);
}

/**
 * A single selectable Ryu Cloud instance, priced from the LIVE Hetzner catalog
 * (specs + live $/mo × markup), injected by the page. The USER never sees the
 * underlying Hetzner type name — only CPU / RAM / SSD + a perf label + price.
 * `type` is the opaque checkout key (passed back on select), never rendered.
 */
export interface PricingCloudInstance {
	/** True in the currently selected location. */
	readonly availableInLocation: boolean;
	readonly cores: number;
	readonly diskGb: number;
	/** True for the generic base candidate; retained for compatibility. */
	readonly includedWithMax: boolean;
	/** True when this exact instance is included by the selected plan and region. */
	readonly includedWithPlan?: boolean;
	readonly memoryGb: number;
	/** Customer-facing monthly USD (live × markup); 0 for the included base. */
	readonly monthlyUsd: number;
	/** User-facing perf class label ("Cost-optimized" | "Performance" | "ARM"). */
	readonly perfLabel: string;
	/** Opaque Hetzner type key — the checkout argument, NEVER displayed. */
	readonly type: string;
}

/** A selectable Hetzner location, shown to the user as city + country. */
export interface PricingCloudLocation {
	readonly city: string;
	readonly country: string;
	readonly id: string;
}

/**
 * Ryu Cloud dynamic instance picker — managed nodes (Core + Gateway hosted for
 * you). Reads a live catalog (specs + live $/mo × markup + regional
 * availability) injected by the page; the user picks a location and a node.
 * The base node ships free with every recurring plan (shown "Included with
 * your plan", never a
 * checkout); every other node is an ad-hoc cloud-instance subscription. The USER
 * only ever sees CPU / RAM / SSD + a perf label + price — never the Hetzner type
 * name. Presentational: the page fetches the catalog and wires the handlers.
 *
 * Cloud instances are billed monthly regardless of the plan monthly/yearly
 * toggle above (that toggle only applies to the subscription plans), so this
 * never reads `isYearly`.
 */
export function PricingInstancePicker({
	instances = [],
	locations = [],
	location = "",
	live = true,
	loadingType = null,
	onLocationChange = noop,
	onSelectInstance = noop,
}: {
	instances?: readonly PricingCloudInstance[];
	live?: boolean;
	loadingType?: string | null;
	location?: string;
	locations?: readonly PricingCloudLocation[];
	onLocationChange?: (locationId: string) => void;
	onSelectInstance?: (type: string) => void;
}) {
	if (instances.length === 0) {
		return null;
	}
	return (
		<div className="mx-auto mb-12 max-w-7xl">
			<div className="mb-6 text-center">
				<h2 className="flex items-center justify-center gap-2 font-semibold text-2xl">
					<Server className="size-5" />
					Ryu Cloud
				</h2>
				<p className="mt-1 text-muted-foreground">
					We host Core, Gateway, and your agents on your server. Your hosted
					plan includes a base server, and you can add a bigger server when you
					need more performance
				</p>
				<p className="mt-1 text-muted-foreground text-xs">
					Servers are billed monthly at live cost. The yearly toggle
					doesn&apos;t apply to Cloud servers
				</p>
			</div>
			{locations.length > 0 ? (
				<div className="mb-6 flex items-center justify-center gap-2">
					<label
						className="text-muted-foreground text-sm"
						htmlFor="ryu-cloud-location"
					>
						Region
					</label>
					<Select
						items={locations.map((loc) => ({
							label: `${loc.city}, ${loc.country}`,
							value: loc.id,
						}))}
						// The Select can emit `null` when cleared; there is no
						// "no location" state to report, so that case is ignored.
						onValueChange={(value) => {
							if (value !== null) {
								onLocationChange(value);
							}
						}}
						value={location}
					>
						<SelectTrigger className="w-56" id="ryu-cloud-location">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{locations.map((loc) => (
								<SelectItem key={loc.id} value={loc.id}>
									{loc.city}, {loc.country}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			<div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{instances.map((instance) => {
					const isIncluded =
						instance.includedWithPlan ?? instance.includedWithMax;
					const isLoading = loadingType === instance.type;
					const unavailable = !(isIncluded || instance.availableInLocation);
					return (
						<Card
							className={
								isIncluded
									? "relative flex flex-col border-primary"
									: "relative flex flex-col"
							}
							key={instance.type}
						>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-xl">
									{isIncluded ? (
										<Cloud className="size-4 text-primary" />
									) : (
										<Cpu className="size-4 text-primary" />
									)}
									{instance.perfLabel}
								</CardTitle>
								<CardDescription>
									{instance.cores} vCPU, {instance.memoryGb} GB RAM, and{" "}
									{instance.diskGb} GB SSD
								</CardDescription>
							</CardHeader>
							<CardContent className="flex-1">
								{isIncluded ? (
									<div className="mb-6 flex items-baseline">
										<span className="font-semibold text-4xl">Included</span>
										<span className="ml-2 text-muted-foreground">
											with your plan
										</span>
									</div>
								) : (
									<div className="mb-6 flex items-baseline">
										<NumberTicker
											className="font-heading font-semibold text-4xl tabular-nums"
											prefix="$"
											value={instance.monthlyUsd}
										/>
										<span className="ml-1 text-muted-foreground">/mo</span>
									</div>
								)}
								<ul className="space-y-3">
									<li className="flex items-center">
										<Cpu className="mr-2 size-4" />
										<span>{instance.cores} vCPU</span>
									</li>
									<li className="flex items-center">
										<Server className="mr-2 size-4" />
										<span>{instance.memoryGb} GB RAM</span>
									</li>
									<li className="flex items-center">
										<Cloud className="mr-2 size-4" />
										<span>{instance.diskGb} GB SSD</span>
									</li>
								</ul>
							</CardContent>
							<CardFooter>
								{isIncluded ? (
									<Button className="w-full" disabled variant="outline">
										Included with your plan
									</Button>
								) : (
									<Button
										className="w-full"
										disabled={unavailable}
										loading={isLoading}
										onClick={() => onSelectInstance(instance.type)}
									>
										{isLoading
											? "Processing"
											: unavailable
												? "Not in this region"
												: "Deploy server"}
									</Button>
								)}
							</CardFooter>
						</Card>
					);
				})}
			</div>
			<p className="mt-4 text-center text-muted-foreground text-xs">
				{live
					? "Prices track live compute cost"
					: "Estimated pricing because the live catalog is unavailable"}{" "}
				You can self-host by running `infra/provision.sh` against your own cloud
				account
			</p>
		</div>
	);
}
