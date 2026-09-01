/**
 * THE FIRST-PURCHASE VOUCHER — the one customer-typable discount code, and the
 * list of plans it is allowed to touch.
 *
 * A voucher is not a plan, a benefit or an entitlement: it is a percentage the
 * customer types into a Polar checkout. Everything about it that both the
 * provisioning script and the marketing surface must agree on lives here, so the
 * code printed on a page can never drift from the code created in Polar.
 *
 * DELIBERATELY A CLIENT-SAFE SIBLING of `plans.ts`, exactly like `base-node.ts`:
 * the surfaces that print the code (`/campaign/card`, and any pricing copy that
 * follows) are public React trees, and importing `plans.ts` would ship the whole
 * control-plane catalog — every Polar product id and env-var name — to a browser
 * to read one string. Nothing in this file is a product id or a secret; the
 * slug → product-id mapping stays in `constants.ts` where the script resolves it.
 *
 * WHY THE ELIGIBLE SET IS A LIST AND NOT "EVERYTHING": a 10% discount is not
 * uniformly affordable across the catalog. Managed plans have plan-specific
 * pools and margins, and Polar's `once` duration covers a whole billing period.
 * The exclusions below keep the printed first-month offer scoped to the one
 * checkout path that has been provisioned and margin-checked.
 */

/** How the discount recurs. `once` = the first billing period only. */
export type VoucherDuration = "once" | "forever" | "repeating";

/** The customer-typable code. Alphanumeric only — Polar rejects anything else. */
export const FIRST_PURCHASE_VOUCHER_CODE = "RYU10";

/** 1000 basis points = 10.00%. Polar expresses percentage discounts in bps. */
export const FIRST_PURCHASE_VOUCHER_BASIS_POINTS = 1000;

/**
 * `once` — the first billing period only, then the plan renews at list price.
 *
 * READ THIS BEFORE WIDENING THE ELIGIBLE SET. Polar's `once` means the first
 * BILLING PERIOD, not the first month: on a yearly product it discounts the
 * whole first year rather than one month's amount. Verified against the API,
 * not inferred — a sandbox checkout for the yearly Pro product went $390.00 →
 * $351.00 when the code was applied.
 *
 * That single fact is why the eligible set below is MONTHLY ONLY. Restricting
 * the products is what makes "10% off your first month" a true sentence rather
 * than an approximation: on every product the code can reach, one billing period
 * IS one month, so the offer means exactly what it says and cannot quietly pay
 * out twelve times what was advertised.
 */
export const FIRST_PURCHASE_VOUCHER_DURATION: VoucherDuration = "once";

/**
 * Name shown to the customer in Polar's checkout once the code is applied. Says
 * "month" because the eligible products are monthly, so the two cannot disagree
 * — if a yearly product is ever added, this string is wrong before anything else
 * is.
 */
export const FIRST_PURCHASE_VOUCHER_NAME = "10% off your first month";

/**
 * The plan slugs (the `POLAR_PRODUCTS` keys in `constants.ts`) the voucher may
 * be redeemed against. Polar scopes a discount by PRODUCT, so this list becomes
 * the discount's `products` array: a code typed on any other checkout is
 * refused by Polar itself, not by our code. That is the safety property — the
 * exclusions cannot be bypassed by a client, a stale deploy, or a checkout route
 * that forgets to check.
 */
export const FIRST_PURCHASE_VOUCHER_SLUGS: readonly string[] = ["pro-monthly"];

/**
 * The slugs deliberately left out, and why. Kept as data (not a comment) so the
 * margin test can assert the set, and so removing an exclusion is a visible,
 * reviewable edit rather than a silent deletion.
 *
 * Worst case assumes a subscriber spends 100% of the included credit pool, which
 * is the only assumption that makes the number a FLOOR — the pool is
 * use-it-or-lose-it (the subscription bucket RESETS each period, it does not
 * roll over), so real margin is higher whenever it goes unspent.
 */
export const FIRST_PURCHASE_VOUCHER_EXCLUSIONS: Readonly<
	Record<string, string>
> = {
	// EVERY YEARLY PRODUCT IS OUT, for two different reasons that happen to point
	// the same way.
	//
	// The one that would still hold if the money worked: `once` is a BILLING
	// PERIOD, so on a yearly product the code takes 10% of a whole year. The
	// offer this voucher advertises is "your first month". Honouring a
	// first-month promise with a first-year discount is a $39–$200 giveaway
	// nobody asked for, and describing it accurately on the card would mean
	// printing two different offers on one page.
	//
	// The current campaign is deliberately Pro-only. Max is a hidden compatibility
	// offer, and Teams/Business use organization checkout; none are this card's
	// first-month path.
	"pro-yearly":
		"`once` covers the whole first year, but the offer promises a first MONTH",
	"teams-yearly":
		"`once` covers the whole first year, but the offer promises a first MONTH",
	"business-yearly":
		"`once` covers the whole first year, but the offer promises a first MONTH",
	"max-yearly":
		"`once` covers the whole first year, but the offer promises a first MONTH",
	"marketplace-membership-monthly":
		"A Major Pass provides Marketplace access only, not the Pro managed plan",
	"marketplace-membership-yearly":
		"A Major Pass provides Marketplace access only, not the Pro managed plan",
	"max-monthly":
		"Max is a hidden compatibility offer, not this card campaign's path",
	"teams-monthly": "Teams uses a separate organization checkout and is not Pro",
	"business-monthly":
		"Business uses a separate organization checkout and is not Pro",
	// The desktop licence already carries the server-applied LIFETIME129 discount
	// ($71 off a $200 product = the advertised $129). Polar allows one discount
	// per checkout, so stacking is impossible either way; a voucher would only
	// create a second, conflicting lifetime offer.
	lifetime:
		"already discounted by LIFETIME129 to $129; a second percentage offer would conflict with the launch price",
	// Credit top-ups are not a plan. Their entire margin IS the deposit fee, and
	// the fee covers the provider costs — so a 10% discount would trim the margin
	// materially.
	credits: "not a plan; the deposit fee IS the margin, so 10% off cancels it",
	// Ad-hoc cloud instances are an add-on subscription with a dynamic
	// per-checkout price, not a plan the voucher advertises.
	"cloud-instance": "an ad-hoc add-on, not a plan",
};

/** Whether the voucher may be redeemed against `slug`. */
export const voucherAppliesToSlug = (slug: string): boolean =>
	FIRST_PURCHASE_VOUCHER_SLUGS.includes(slug);
