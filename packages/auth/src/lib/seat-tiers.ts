/**
 * TEAMS SEAT PRICING — a simple, auditable member-seat meter.
 *
 * The complaint this answers, stated plainly: a twenty-person company paid
 * twenty times the per-seat price, received exactly ONE free node (the same as a
 * solo user), and the only "upgrade" on offer was a tier that cost more than
 * simply buying the credits it bundled. Growing cost more and bought nothing.
 * Teams starts at five seats ($250/mo) and adds seats at $50/mo. Larger
 * organizations move to Enterprise, where procurement, security and committed
 * volume terms can be negotiated without making the self-serve price curve
 * impossible to explain.
 *
 * ENFORCED BY POLAR, NOT BY US. A Polar seat-based price carries native
 * `seat_tiers` of type `volume`, so these rows become the product's tier array
 * and Polar computes the charge. Nothing in the app applies a discount, which
 * means there is no second code path to keep in sync and no way for a client to
 * ask for a tier it has not earned. Ryu's surfaces only ever DISPLAY this.
 *
 * CLIENT-SAFE, like `base-node.ts` and `vouchers.ts`: the pricing page is a
 * public React tree and must not import the control-plane catalog to render a
 * table. Nothing here is a product id, a price id, or a secret — the ladder is
 * expressed in basis points off list, and the seat price it applies to lives in
 * `plans.ts`.
 */

/** One tier of the volume ladder: from `minSeats` up, take `discountBps` off. */
export interface SeatTier {
	/** Discount off the list seat price, in basis points (500 = 5%). */
	readonly discountBps: number;
	/** The seat count at which this tier starts applying. */
	readonly minSeats: number;
}

/**
 * The ladder, ascending. The first row is list price so the table reads as one
 * continuous scale rather than "normal, then some discounts" — a buyer at 8
 * seats should be able to see what 10 would get them.
 *
 * Deliberately mirrors Copilot's breakpoints (10 / 25 / 50). Matching a
 * convention a buyer has already met elsewhere is worth more than a bespoke
 * curve: it reads as standard rather than as something to negotiate.
 */
export const TEAMS_SEAT_TIERS: readonly SeatTier[] = [
	{ minSeats: 5, discountBps: 0 },
];

/** The discount (bps) that applies at `seats` — the highest tier reached. */
export const seatDiscountBps = (seats: number): number => {
	let bps = 0;
	for (const tier of TEAMS_SEAT_TIERS) {
		if (seats >= tier.minSeats) {
			bps = tier.discountBps;
		}
	}
	return bps;
};

/**
 * The per-seat price at `seats`, given the list price. Rounded to whole cents so
 * a displayed figure and the amount Polar charges cannot disagree by a
 * fraction — Polar prices seats in integer minor units, and a UI that shows
 * $46.55 while the invoice says $46.56 reads as a bug even though it is
 * rounding.
 */
export const seatPriceUsd = (listUsd: number, seats: number): number =>
	Math.round(listUsd * (1 - seatDiscountBps(seats) / 10_000) * 100) / 100;

/**
 * WHERE SELF-SERVE STOPS. Above this, Teams checkout refuses and the buyer is
 * routed to sales.
 *
 * 50 is the self-serve line: above it a
 * buyer usually needs something self-serve cannot do anyway — SSO,
 * invoicing against a PO, a security review, custom terms — so a card-form
 * purchase at that size is one procurement would have blocked after we had
 * already taken the money.
 *
 * It also protects the price and creates a clean handoff to Enterprise for
 * procurement, security review, regional capacity, and negotiated volume terms.
 *
 * ENFORCED SERVER-SIDE, not just in the picker. A cap that lives only in a React
 * component is a suggestion: the checkout route takes a seat count from the
 * request body, and `Math.max(requested, minSeats)` is a floor with no ceiling.
 */
export const SELF_SERVE_MAX_SEATS = 50;

/** Whether `seats` is beyond self-serve and belongs to sales. */
export const exceedsSelfServe = (seats: number): boolean =>
	seats > SELF_SERVE_MAX_SEATS;
