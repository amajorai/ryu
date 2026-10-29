import {
	DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS,
	discountedPeriodPaidMicroUsd,
	discountedPeriodPoolMicroUsd,
} from "./agent-plans.ts";
import { usdToMicro } from "./plans.ts";

const LIST_MONTHLY_PRICE_USD = 250;
const DISCOUNT_BASIS_POINTS = 8000;
const LIST_MONTHLY_POOL_USD = 50;

const FIRST_MONTH_PAID_MICRO_USD = discountedPeriodPaidMicroUsd({
	discountBasisPoints: DISCOUNT_BASIS_POINTS,
	listPriceMicroUsd: usdToMicro(LIST_MONTHLY_PRICE_USD),
});

/**
 * Customer-facing Teams activation offer used by desktop onboarding.
 *
 * The discounted month carries a reduced shared credit pool: at most
 * {@link DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS} of what was paid, so
 * the month covers its included node. Every display and checkout reads these
 * figures; nothing restates them.
 */
export const ONBOARDING_TEAMS_OFFER = {
	discountBasisPoints: DISCOUNT_BASIS_POINTS,
	durationMonths: 1,
	/** Shared credit pool granted while the discount is active. */
	firstMonthCreditPoolUsd:
		discountedPeriodPoolMicroUsd({
			listPoolMicroUsd: usdToMicro(LIST_MONTHLY_POOL_USD),
			paidMicroUsd: FIRST_MONTH_PAID_MICRO_USD,
		}) / 1_000_000,
	includedSeats: 5,
	listMonthlyCreditPoolUsd: LIST_MONTHLY_POOL_USD,
	listMonthlyPriceUsd: LIST_MONTHLY_PRICE_USD,
	/** One redemption per account that owns the organization, not per org. */
	redemptionsPerOwnerAccount: 1,
	trialMonthlyPriceUsd: FIRST_MONTH_PAID_MICRO_USD / 1_000_000,
} as const;

/** Polar discount is valid only on the monthly five-seat Teams product. */
export function onboardingOfferAppliesTo(slug: string): boolean {
	return slug.trim() === "teams-monthly";
}

/** Server-set checkout metadata key naming the onboarding offer. */
export const ONBOARDING_OFFER_METADATA_KEY = "desktopOnboardingOffer";
/** Value of {@link ONBOARDING_OFFER_METADATA_KEY}; kept for existing records. */
export const ONBOARDING_OFFER_METADATA_VALUE = "one_month_fifty_then_two_fifty";
/** Server-set checkout metadata key holding the redeeming owner account. */
export const ONBOARDING_OFFER_OWNER_METADATA_KEY = "onboardingOfferOwnerUserId";

/**
 * Polar subscription metadata filters that find an earlier redemption by any of
 * `userIds`. Records created before the owner stamp carry only the checkout
 * initiator's `userId`, so both keys are searched.
 */
export function onboardingOfferRedemptionFilters(
	userIds: readonly (string | null | undefined)[]
): Record<string, string>[] {
	const unique = [
		...new Set(
			userIds
				.map((id) => id?.trim() ?? "")
				.filter((id): id is string => id.length > 0)
		),
	];
	const filters: Record<string, string>[] = [];
	for (const userId of unique) {
		for (const key of [ONBOARDING_OFFER_OWNER_METADATA_KEY, "userId"]) {
			filters.push({
				[ONBOARDING_OFFER_METADATA_KEY]: ONBOARDING_OFFER_METADATA_VALUE,
				[key]: userId,
			});
		}
	}
	return filters;
}
