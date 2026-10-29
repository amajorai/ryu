import {
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import { PRICING_COPY } from "./data/standalone-pricing.ts";
import {
	normalizeTeamsSeatCount,
	TEAMS_MIN_SEATS,
} from "./pricing-seat-model.ts";

export type PricingPlanSlug =
	| "lifetime"
	| "marketplace-membership-monthly"
	| "marketplace-membership-yearly"
	| "plus-monthly"
	| "plus-yearly"
	| "pro-monthly"
	| "pro-yearly"
	| "max-monthly"
	| "max-yearly"
	| "teams-monthly"
	| "teams-yearly"
	| "teams-lite-monthly"
	| "teams-lite-yearly"
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
	| "plus"
	| "pro"
	| "max"
	| "teams"
	| "teams-lite"
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

export const noop = () => {
	// presentational default; the live page injects real handlers
};

/* -------------------------------------------------------------------------- *
 * Advertised list prices, in whole USD per month.
 *
 * These MIRROR the current rows of `PLAN_VERSIONS` / `PLAN_MONTHLY_PRICE_MICRO_USD`
 * in `@ryu/auth/lib/plans` (the billing source of truth). They are duplicated
 * here — not imported — because these cards render in browser bundles (the web
 * pricing page, the desktop paywall, the storyboard), and importing the plan
 * catalog would ship every Polar product id and env-var name to the client.
 * `pricing-catalog-drift.test.ts` asserts every figure below against the
 * catalog, so a price change in `plans.ts` fails until it is mirrored here.
 * Deposit-fee and hosted-mail figures come from `PUBLISHED_PRICING` in
 * `./data/standalone-pricing.ts`.
 * -------------------------------------------------------------------------- */
export const PRO_MONTHLY_USD = 49;
/** Private lower-usage Pro companion price; omitted from the public shelf. */
export const PLUS_MONTHLY_USD = 39;
/** The recurring A Major Pass price per user. */
export const MARKETPLACE_PASS_MONTHLY_USD = 20;
/** A Major Pass yearly price per user (two months free). */
export const MARKETPLACE_PASS_YEARLY_USD = 200;
/** Max is the public single-seat individual power tier. */
export const MAX_MONTHLY_USD = 99;
/**
 * Teams is a native member-seat offer: $50/member/month with a five-seat
 * minimum ($250 floor).
 */
export const TEAMS_MONTHLY_USD = 250;
/** The Teams price per billed member seat. */
export const TEAMS_MONTHLY_PER_SEAT_USD = 50;
/** Private Teams Lite floor: $100 below Teams at five seats. */
export const TEAMS_LITE_MONTHLY_USD = 150;
/** Teams Lite's first-five-seat price; later seats use the standard $50 rate. */
export const TEAMS_LITE_MONTHLY_PER_SEAT_USD = 30;
export const TEAMS_LITE_ADDITIONAL_SEAT_USD = 50;
/** The price of each billed member seat above an organization plan's floor. */
export const TEAMS_AGENT_STANDARD_USD = 50;
/**
 * Max is SINGLE-SEAT. The constant stays at 1 (and the card shows no seat
 * stepper) because Max used to be seat-scalable, which put two multi-seat
 * business plans side by side differing only in credit volume. Multi-seat is
 * Teams' job.
 */
export const MAX_MIN_SEATS = 1;

/* -------------------------------------------------------------------------- *
 * Included AI usage, in whole USD per month (mirrors of the catalog's current
 * version rows; see the drift test above).
 *
 * Organization cards use `hostedAgentIncludedCreditUsd`, so the Teams pool
 * grows with each started five-seat bundle while its member-seat quantity
 * changes.
 * -------------------------------------------------------------------------- */
export const PRO_INCLUDED_USD = 14;
/** Plus keeps Pro capacity with a lower fixed monthly credit pool. */
export const PLUS_INCLUDED_USD = 9;
export const MAX_INCLUDED_USD = 30;
export const TEAMS_INCLUDED_USD = 50;
/** Current Teams credit grant: one $50 pool for each started five-seat bundle. */
export const TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE = 5;
export const TEAMS_INCLUDED_PER_BUNDLE_USD = 50;
/** Teams Lite is a private lower-usage offer with a $20 pool per started five-seat bundle. */
export const TEAMS_LITE_INCLUDED_USD = 20;
export const TEAMS_LITE_INCLUDED_CREDIT_BUNDLE_SIZE = 5;
export const TEAMS_LITE_INCLUDED_PER_BUNDLE_USD = 20;

/** Organization plans priced by the hosted (seat-slider) cards. */
export type HostedAgentPricingPlanId = "teams" | "teams-lite" | "business";

export const HOSTED_AGENT_SLIDER_MIN = TEAMS_MIN_SEATS;

/**
 * Every managed plan includes one always-on server. Public copy names no
 * CPU, memory, or disk figures: the server resolves the shape per plan and
 * region, and that shape can change without a pricing change.
 */
export const ALWAYS_ON_SERVER_COPY = "An always-on Ryu server included";
/**
 * Individual plans cannot place their included server in Singapore; the
 * billing API refuses that region for them.
 */
export const SINGAPORE_SERVER_COPY =
	"Singapore servers come with Teams and Business only";

/** The current monthly deposit-fee line every managed plan card quotes. */
export const depositFeeLine = (rate: string): string =>
	`${rate} deposit fee (${PRICING_COPY.depositFeeMinimum} minimum, Ryu keeps at most ${PRICING_COPY.depositFeeCap})`;

/**
 * Shared monthly AI credits for an organization. Teams and Teams Lite add one
 * pool for each started five-seat bundle; Business adds one for each completed
 * bundle.
 */
export function hostedAgentIncludedCreditUsd(
	planId: HostedAgentPricingPlanId,
	agentCount: number
): number {
	if (planId === "business") {
		return businessIncludedCreditUsd(agentCount);
	}
	const seats = normalizeTeamsSeatCount(agentCount);
	if (planId === "teams-lite") {
		return (
			Math.ceil(seats / TEAMS_LITE_INCLUDED_CREDIT_BUNDLE_SIZE) *
			TEAMS_LITE_INCLUDED_PER_BUNDLE_USD
		);
	}
	return (
		Math.ceil(seats / TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE) *
		TEAMS_INCLUDED_PER_BUNDLE_USD
	);
}

/** The monthly price at a billed organization seat count. */
export function hostedAgentMonthlyPriceUsd(
	planId: HostedAgentPricingPlanId,
	agentCount: number
): number {
	if (planId === "business") {
		return businessMonthlyPriceUsd(agentCount);
	}
	const seats = normalizeTeamsSeatCount(agentCount);
	if (planId === "teams-lite") {
		return (
			Math.min(seats, TEAMS_MIN_SEATS) * TEAMS_LITE_MONTHLY_PER_SEAT_USD +
			Math.max(0, seats - TEAMS_MIN_SEATS) * TEAMS_LITE_ADDITIONAL_SEAT_USD
		);
	}
	return TEAMS_MONTHLY_PER_SEAT_USD * seats;
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
export type PricingDeployment = "platform" | "self-hosted" | "standalone";
