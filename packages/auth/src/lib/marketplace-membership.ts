import { PLANS, type PlanId } from "./plans.ts";

/** The offer shapes that can contribute an A Major Pass price tier. */
export type MarketplaceMembershipPricingModel =
	| "bounded_updates"
	| "one_time"
	| "subscription";

export interface MarketplaceMembershipPricing {
	amountMinor: number;
	currency?: string;
	interval: "month" | "year";
	model: MarketplaceMembershipPricingModel;
}

/** The publisher share of each paid recurring invoice, in basis points. */
export const DEFAULT_MARKETPLACE_MEMBERSHIP_PUBLISHER_SHARE_BPS = 7000;

interface MarketplacePriceTier {
	maxAnnualizedUsd: number | null;
	multiplier: number;
}

/**
 * Setapp-shaped annualized price tiers. The table is intentionally data rather
 * than a ladder of conditionals so policy can be reviewed and replaced without
 * changing the allocation algorithm.
 */
export const MARKETPLACE_PRICE_TIERS: readonly MarketplacePriceTier[] = [
	{ maxAnnualizedUsd: 1.99, multiplier: 1 },
	{ maxAnnualizedUsd: 3.99, multiplier: 2 },
	{ maxAnnualizedUsd: 5.99, multiplier: 3 },
	{ maxAnnualizedUsd: 7.99, multiplier: 4 },
	{ maxAnnualizedUsd: 11.99, multiplier: 5 },
	{ maxAnnualizedUsd: 15.99, multiplier: 7 },
	{ maxAnnualizedUsd: 21.99, multiplier: 10 },
	{ maxAnnualizedUsd: 27.99, multiplier: 13 },
	{ maxAnnualizedUsd: 33.99, multiplier: 15 },
	{ maxAnnualizedUsd: 43.99, multiplier: 20 },
	{ maxAnnualizedUsd: 53.99, multiplier: 24 },
	{ maxAnnualizedUsd: 65.99, multiplier: 30 },
	{ maxAnnualizedUsd: 77.99, multiplier: 35 },
	{ maxAnnualizedUsd: 93.99, multiplier: 43 },
	{ maxAnnualizedUsd: 125.99, multiplier: 57 },
	{ maxAnnualizedUsd: 173.99, multiplier: 79 },
	{ maxAnnualizedUsd: null, multiplier: 100 },
];

/**
 * True only for a recurring plan whose contract funds the Marketplace publisher
 * pool. Marketplace access and publisher funding are separate plan properties:
 * Pro, Max, Teams, and Business can access supported paid apps without making
 * their managed-inference price carry an unrelated publisher liability.
 */
export function isRecurringMarketplacePlan(
	plan: PlanId | null | undefined
): boolean {
	if (!plan) {
		return false;
	}
	const definition = PLANS[plan];
	return Boolean(
		definition.marketplacePublisherPool &&
			(definition.bindings.monthly || definition.bindings.yearly)
	);
}

export interface MarketplaceMembershipListing {
	kind: string;
	marketplaceVisibility?: string | null;
	origin?: string | null;
	pricing?: {
		membershipOptIn?: boolean | null;
		model?: string | null;
		sellerOrgId?: string | null;
	} | null;
	status?: string | null;
}

/** The minimum seller state required before an opt-in can become visible. */
export interface MarketplaceMembershipPublisherState {
	payoutsEnabled: boolean;
}

/**
 * Server-side eligibility predicate for the public Membership badge and usage
 * path. Community rows never reach this predicate in normal operation, but the
 * explicit origin check keeps a malformed/federated payload fail-closed.
 */
export function isMarketplaceMembershipListingEligible(
	listing: MarketplaceMembershipListing,
	publisher: MarketplaceMembershipPublisherState
): boolean {
	const model = listing.pricing?.model;
	const isPaid =
		model === "one_time" ||
		model === "subscription" ||
		model === "bounded_updates";
	return Boolean(
		listing.status === "live" &&
			listing.kind === "app" &&
			listing.marketplaceVisibility !== "organization" &&
			listing.origin !== "community" &&
			isPaid &&
			listing.pricing?.membershipOptIn === true &&
			listing.pricing.sellerOrgId?.trim() &&
			publisher.payoutsEnabled
	);
}

/** Convert a stored offer into the annualized minor-unit amount used for tiers. */
export function annualizedMarketplacePriceMinor(
	pricing: MarketplaceMembershipPricing
): number {
	const amount =
		Number.isInteger(pricing.amountMinor) && pricing.amountMinor > 0
			? pricing.amountMinor
			: 0;
	if (pricing.model === "subscription" && pricing.interval === "month") {
		return amount * 12;
	}
	return amount;
}

/** Resolve the deterministic price-tier multiplier for one stored offer. */
export function marketplaceTierMultiplier(
	pricing: MarketplaceMembershipPricing
): number {
	const annualizedUsd = annualizedMarketplacePriceMinor(pricing) / 100;
	return (
		MARKETPLACE_PRICE_TIERS.find(
			(tier) =>
				tier.maxAnnualizedUsd === null || annualizedUsd <= tier.maxAnnualizedUsd
		)?.multiplier ?? 1
	);
}

export interface MarketplaceMembershipAppWeight {
	appId: string;
	multiplier: number;
	publisherOrgId: string;
}

export interface MarketplaceMembershipAllocation {
	amountMinor: number;
	appId: string;
	publisherOrgId: string;
}

export interface AllocateMarketplaceMembershipPoolInput {
	apps: readonly MarketplaceMembershipAppWeight[];
	invoiceMinor: number;
	/** Frozen pool from the billing-period row, when settling asynchronously. */
	publisherPoolMinor?: number;
	publisherShareBps: number;
}

/**
 * Allocate the publisher pool across the unique apps used in one billing
 * period. All arithmetic stays in integer minor units; the deterministic
 * remainder goes to the heaviest app so the allocation exactly reconciles.
 */
export function allocateMarketplaceMembershipPool(
	input: AllocateMarketplaceMembershipPoolInput
): MarketplaceMembershipAllocation[] {
	const invoiceMinor =
		Number.isInteger(input.invoiceMinor) && input.invoiceMinor > 0
			? input.invoiceMinor
			: 0;
	const publisherShareBps = Number.isInteger(input.publisherShareBps)
		? Math.min(Math.max(input.publisherShareBps, 0), 10_000)
		: 0;
	const publisherPoolMinor =
		Number.isInteger(input.publisherPoolMinor) && input.publisherPoolMinor >= 0
			? input.publisherPoolMinor
			: Math.floor((invoiceMinor * publisherShareBps) / 10_000);
	if (publisherPoolMinor === 0) {
		return [];
	}

	const uniqueApps: MarketplaceMembershipAppWeight[] = [];
	const seen = new Set<string>();
	for (const app of input.apps) {
		const appId = app.appId.trim();
		const publisherOrgId = app.publisherOrgId.trim();
		if (
			!(appId && publisherOrgId) ||
			seen.has(appId) ||
			!Number.isFinite(app.multiplier) ||
			app.multiplier <= 0
		) {
			continue;
		}
		seen.add(appId);
		uniqueApps.push({ appId, multiplier: app.multiplier, publisherOrgId });
	}
	if (uniqueApps.length === 0) {
		return [];
	}

	const totalMultiplier = uniqueApps.reduce(
		(total, app) => total + app.multiplier,
		0
	);
	if (!(totalMultiplier > 0)) {
		return [];
	}

	const allocations = uniqueApps.map((app) => ({
		amountMinor: Math.floor(
			(publisherPoolMinor * app.multiplier) / totalMultiplier
		),
		appId: app.appId,
		publisherOrgId: app.publisherOrgId,
	}));
	const allocatedMinor = allocations.reduce(
		(total, allocation) => total + allocation.amountMinor,
		0
	);
	const remainderMinor = publisherPoolMinor - allocatedMinor;
	if (remainderMinor > 0) {
		let heaviestIndex = 0;
		for (let index = 1; index < uniqueApps.length; index += 1) {
			const candidate = uniqueApps[index];
			const current = uniqueApps[heaviestIndex];
			if (
				candidate.multiplier > current.multiplier ||
				(candidate.multiplier === current.multiplier &&
					candidate.appId < current.appId)
			) {
				heaviestIndex = index;
			}
		}
		const heaviest = allocations[heaviestIndex];
		if (heaviest) {
			heaviest.amountMinor += remainderMinor;
		}
	}
	return allocations;
}
