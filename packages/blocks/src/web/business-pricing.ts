/** Client-safe mirror of the Business organization pricing contract. */
export const BUSINESS_BASE_MONTHLY_USD = 300;
export const BUSINESS_INCLUDED_SEATS = 5;
export const BUSINESS_ADDITIONAL_SEAT_USD = 50;
export const BUSINESS_INCLUDED_CREDIT_USD = 100;
export const BUSINESS_CREDIT_BUNDLE_SIZE = 5;

const normalizedBusinessSeats = (seats: number): number =>
	Number.isFinite(seats)
		? Math.max(BUSINESS_INCLUDED_SEATS, Math.floor(seats))
		: BUSINESS_INCLUDED_SEATS;

/** Business's actual monthly amount at a billed human-seat quantity. */
export const businessMonthlyPriceUsd = (seats: number): number => {
	const normalized = normalizedBusinessSeats(seats);
	return (
		BUSINESS_BASE_MONTHLY_USD +
		Math.max(0, normalized - BUSINESS_INCLUDED_SEATS) *
			BUSINESS_ADDITIONAL_SEAT_USD
	);
};

/**
 * Pooled monthly AI credits at a billed human-seat quantity.
 *
 * Business uses completed five-seat bundles: 5–9 seats receive $100, 10–14
 * receive $200, and so on. That keeps the credit grant stable when one person
 * is added and matches the versioned server-side entitlement contract.
 */
export const businessIncludedCreditUsd = (seats: number): number =>
	Math.max(
		1,
		Math.floor(normalizedBusinessSeats(seats) / BUSINESS_CREDIT_BUNDLE_SIZE)
	) * BUSINESS_INCLUDED_CREDIT_USD;
