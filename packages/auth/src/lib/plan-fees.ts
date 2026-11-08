import {
	MICRO_USD_PER_USD,
	type PlanId,
	type PolarBinding,
	usdToMicro,
} from "./plan-core.ts";

/** Plan catalog part: Deposit fees, credit top-up economics, invite passes and the included-pool cap. Re-exported by `plans.ts`. */

/**
 * One-time deposit fee (markup) on credit top-ups. Ryu's PREPAID model: a
 * customer buys credits up front, then spends them — models are metered AT COST
 * (no per-token markup) and tool calls use the configured provider rate; the
 * platform's inference margin is captured once here, at deposit. Lives ONLY here.
 *
 * The fee is `max(plan % of the top-up, $5 floor)` — a MINIMUM, not an
 * add-on. The safe schedule is 27% for the unqualified/base rate, 26.5% for
 * Pro, and 26% for Max and organization plans. It covers the current
 * OpenRouter funding fee, the Singapore GST reserve that starts 2026-09-18,
 * and the highest listed Polar card-processing path, including the
 * international-card surcharge, without adding a usage markup.
 *
 * The floor is NOT a free parameter — see {@link DEPOSIT_FEE_FIXED_MICRO_USD} for
 * why $5 specifically, and why lowering a managed-plan rate below 26% reopens
 * a band of deposits that lose money.
 */
export const DEPOSIT_FEE_BPS = 2700; // 27.00% base rate in basis points

/**
 * The minimum fee on any top-up. **$5, and the number is load-bearing.**
 *
 * The floor and percentage have to overlap under the current conservative
 * processor case: OpenRouter 5.5% with a $0.80 minimum, Singapore GST at 9%
 * on the OpenRouter purchase subtotal, and Polar 6.5% + $0.50 on a
 * transaction. At the 26% managed-plan rate the percentage curve starts
 * clearing its own costs at about $17.76; the $5 floor remains safe through
 * the rounded-cent crossover. The economics test walks every
 * whole-cent value through $600 so a sampled list cannot hide a loss band.
 *
 * A $5 face value therefore costs $10 and a $10 face value costs $15 at
 * the base floor. The checkout returns the exact face, fee, and total before
 * the buyer leaves Ryu.
 */
export const DEPOSIT_FEE_FIXED_MICRO_USD = usdToMicro(5);

/** Current conservative external cost inputs used by the top-up economics guard. */
export const TOPUP_OPENROUTER_FEE_BPS = 550;
export const TOPUP_OPENROUTER_MINIMUM_USD = 0.8;
/** Singapore GST applied to OpenRouter credit purchases from 2026-09-18. */
export const TOPUP_OPENROUTER_GST_BPS = 900;
export const TOPUP_POLAR_PROCESSING_BPS = 650;
export const TOPUP_POLAR_PROCESSING_FIXED_USD = 0.5;

/**
 * Cost to Ryu of stocking `faceUsd` of OpenRouter credits when the upstream
 * Singapore GST is not recoverable. GST is modeled on the OpenRouter purchase
 * subtotal (the face value plus OpenRouter's funding fee), which is the
 * conservative interpretation of the provider notice.
 */
export const openRouterCreditPurchaseCostUsd = (faceUsd: number): number => {
	if (faceUsd <= 0) {
		return 0;
	}
	const fundingFee = Math.max(
		faceUsd * (TOPUP_OPENROUTER_FEE_BPS / 10_000),
		TOPUP_OPENROUTER_MINIMUM_USD
	);
	const taxableSubtotal = faceUsd + fundingFee;
	return taxableSubtotal * (1 + TOPUP_OPENROUTER_GST_BPS / 10_000);
};

/**
 * The most Ryu keeps from any one top-up: **$10**. Above roughly $280 of
 * credits (27%) or $373 (26%), the percentage fee would leave Ryu more than
 * this, so the fee stops growing at the amount that covers the conservative
 * provider costs plus exactly this margin. Smaller top-ups keep their plan rate
 * and $5 minimum unchanged.
 */
export const DEPOSIT_MARGIN_CAP_MICRO_USD = usdToMicro(10);

/**
 * The largest deposit fee that leaves Ryu at most
 * {@link DEPOSIT_MARGIN_CAP_MICRO_USD} on a top-up of `amountMicroUsd`, under
 * the same conservative OpenRouter + GST + Polar case the rates are sized for.
 * Polar charges on the whole payment (face + fee), so solving
 * `fee − upstream − (face + fee) × polarRate − polarFixed = cap` gives
 * `fee = (upstream + face × polarRate + polarFixed + cap) / (1 − polarRate)`.
 *
 * Floored to whole cents: checkout rounds the fee UP to a cent, so a sub-cent
 * cap would let that rounding lift the margin past $10. Because the cap always
 * includes every provider cost, a capped fee can never lose money.
 */
export const depositFeeCapMicroUsd = (amountMicroUsd: number): number => {
	const faceUsd = Math.max(0, amountMicroUsd) / MICRO_USD_PER_USD;
	const polarRate = TOPUP_POLAR_PROCESSING_BPS / 10_000;
	const upstreamUsd = openRouterCreditPurchaseCostUsd(faceUsd) - faceUsd;
	const capUsd =
		(upstreamUsd +
			faceUsd * polarRate +
			TOPUP_POLAR_PROCESSING_FIXED_USD +
			DEPOSIT_MARGIN_CAP_MICRO_USD / MICRO_USD_PER_USD) /
		(1 - polarRate);
	return Math.floor(capUsd * 100) * (MICRO_USD_PER_USD / 100);
};

/**
 * WHY 27% / 26% — the arithmetic that sets the floor under every rate below.
 *
 * Two costs sit under every top-up, and the fee has to clear BOTH:
 *
 *  - **OpenRouter charges 5.5%**, with a current $0.80 minimum, to buy the
 *    credits we then meter out at cost (`markup_bps` is pinned to 0 on purpose).
 *  - **Singapore GST is 9%** on that OpenRouter purchase subtotal from
 *    2026-09-18. This guard assumes the tax is not recoverable until the
 *    upstream account's GST treatment is verified.
 *  - The conservative Polar case is **6.5% + $0.50**: the current Starter
 *    transaction rate plus the listed international-card surcharge.
 *
 * The buyer pays `face + fee` and the wallet is credited `face`
 * (`computeTopupQuote`), so per top-up:
 *
 *     net = (1 − 0.065) × fee − [0.055 + 0.09 × (1 + 0.055) + 0.065] × face − 0.50
 *
 * The 26% managed-plan rate and $5 floor are the smallest rounded schedule
 * in this catalog that stays non-negative through the floor/percentage join in
 * that conservative case. The fee is the only Ryu spread on inference; usage
 * remains at cost.
 *
 * The 26% managed-plan rate clears it with room for the international-card
 * surcharge (+1.5%) and leaves the "models are metered AT COST, no per-token
 * markup" promise intact — the fee is what covers the two costs above, and it
 * is the only place Ryu takes a spread on inference.
 */

/**
 * The smallest top-up that is profitable at a given rate, in whole USD under
 * the conservative processor case — the size at which the percentage finally
 * covers the variable and fixed provider costs. A non-viable rate returns
 * `Infinity`.
 *
 * {@link DEPOSIT_FEE_FIXED_MICRO_USD} exists to cover everything below those
 * points — but only up to the face where the FLOOR itself stops paying, which is
 * why the two numbers are coupled and why the floor is derived from the worst
 * rate on the ladder rather than picked. **Raise the floor if a rate drops**, and
 * check the no-gap assertion in `plan-economics.test.ts`: the floor must stay
 * profitable at least as far as the largest break-even here.
 */
export const topupBreakEvenUsd = (bps: number): number => {
	const rate = bps / 10_000;
	const polarRate = TOPUP_POLAR_PROCESSING_BPS / 10_000;
	const openRouterRate = TOPUP_OPENROUTER_FEE_BPS / 10_000;
	const gstRate = TOPUP_OPENROUTER_GST_BPS / 10_000;
	const minimumRegimeBoundary = TOPUP_OPENROUTER_MINIMUM_USD / openRouterRate;
	const minimumRegimeRate = rate * (1 - polarRate) - (gstRate + polarRate);
	const minimumRegimeBreakEven =
		minimumRegimeRate > 0
			? (TOPUP_OPENROUTER_MINIMUM_USD * (1 + gstRate) +
					TOPUP_POLAR_PROCESSING_FIXED_USD) /
				minimumRegimeRate
			: Number.POSITIVE_INFINITY;
	if (minimumRegimeBreakEven <= minimumRegimeBoundary) {
		return minimumRegimeBreakEven;
	}
	const percentageRegimeRate =
		rate * (1 - polarRate) -
		(openRouterRate + gstRate * (1 + openRouterRate) + polarRate);
	return percentageRegimeRate > 0
		? TOPUP_POLAR_PROCESSING_FIXED_USD / percentageRegimeRate
		: Number.POSITIVE_INFINITY;
};

/**
 * Deposit-fee rate (bps) by active plan.
 *
 * Prepaid top-ups are also available without a managed subscription. Those
 * purchases use the 27% base rate and $5 minimum; managed plans keep their
 * discounted 26.5% / 26% rates and included pools. A positive prepaid wallet is
 * itself the authorization to use metered Ryu-managed services, while app,
 * node, and included-pool entitlements remain separate.
 */
export const DEPOSIT_FEE_BPS_BY_PLAN = {
	"desktop-license": DEPOSIT_FEE_BPS,
	"marketplace-membership": DEPOSIT_FEE_BPS,
	plus: 2650,
	pro: 2650,
	max: 2600,
	teams: 2600,
	"teams-lite": 2600,
	business: 2600,
} satisfies Record<PlanId, number>;

/** The deposit-fee rate (bps) for a buyer on `plan`, falling back to the base rate. */
export const depositFeeBps = (plan: PlanId | null): number =>
	plan ? (DEPOSIT_FEE_BPS_BY_PLAN[plan] ?? DEPOSIT_FEE_BPS) : DEPOSIT_FEE_BPS;

/** Weekly invite passes for accounts without a recurring subscription. */
export const WEEKLY_INVITE_PASSES_BASE = 3;

/** Weekly invite passes by plan; one-time purchases keep the base allowance. */
export const WEEKLY_INVITE_PASSES_BY_PLAN = {
	"desktop-license": WEEKLY_INVITE_PASSES_BASE,
	"marketplace-membership": WEEKLY_INVITE_PASSES_BASE,
	plus: 5,
	pro: 6,
	max: 7,
	"teams-lite": 7,
	teams: 8,
	business: 10,
} satisfies Record<PlanId, number>;

/** How many invite passes an account on `plan` can share each week. */
export const weeklyInvitePasses = (plan: PlanId | null): number =>
	plan
		? (WEEKLY_INVITE_PASSES_BY_PLAN[plan] ?? WEEKLY_INVITE_PASSES_BASE)
		: WEEKLY_INVITE_PASSES_BASE;

/**
 * The deposit fee on a top-up of `amountMicroUsd` for a buyer on `plan`: the
 * GREATER of the (plan-discounted) percentage and the fixed minimum floor,
 * capped so Ryu keeps at most {@link DEPOSIT_MARGIN_CAP_MICRO_USD}. The
 * amount credited to the wallet is the face value, and the buyer pays face plus
 * this fee (computed by the top-up unit). `plan` defaults to null (the base rate).
 */
export const depositFee = (
	amountMicroUsd: number,
	plan: PlanId | null = null
): number => {
	if (amountMicroUsd <= 0) {
		return DEPOSIT_FEE_FIXED_MICRO_USD;
	}
	const variable = Math.round((amountMicroUsd * depositFeeBps(plan)) / 10_000);
	return Math.min(
		Math.max(variable, DEPOSIT_FEE_FIXED_MICRO_USD),
		depositFeeCapMicroUsd(amountMicroUsd)
	);
};

/**
 * The Polar product credits top-ups check out against (epic #496, Unit B2).
 * Credits are NOT a `Plan` (no entitlement, no interval) — they are a single
 * pay-what-you-want product whose `amount` is set per-checkout. Like the plan
 * bindings, the id reads from env with a clearly-fake placeholder default so a
 * misconfigured deploy fails loudly (the checkout layer refuses a placeholder).
 * See `docs/polar-products.md`.
 */
export const CREDITS_TOPUP_BINDING: PolarBinding = {
	productIdEnv: "POLAR_PRODUCT_CREDITS",
	productIdDefault: "polar_product_credits_topup",
};

/**
 * The one-time custom-price product used to fund Ryu gift cards, credit gifts,
 * and non-renewing subscription gifts. The selected face/value is frozen in
 * Ryu's gift record and server-set checkout metadata; the webhook verifies the
 * paid order before activating it.
 */
export const GIFTS_BINDING: PolarBinding = {
	productIdEnv: "POLAR_PRODUCT_GIFTS",
	productIdDefault: "polar_product_gifts",
};

/**
 * The ONE rule for a plan's included credit pool: a fixed FRACTION of its
 * recurring price, documented once, here. The default is 30% — a $40/mo plan
 * grants $12/mo of credits. Teams' current version instead grants one $50
 * organization pool for each five billed seats, applied by
 * {@link resolveEntitlement}. A plan
 * with no recurring price (the one-time desktop license) grants 0.
 *
 * This is the proportional-pool helper. Bundled and grandfathered contracts
 * keep their explicit pool in `PLANS` and `PLAN_VERSIONS`; changing one of those
 * contracts requires changing its current/version row and its checkout
 * snapshot deliberately. No grant amount is inferred from a buyer-controlled
 * checkout value.
 */
export const INCLUDED_CREDIT_FRACTION_DEFAULT = 0.3;

/**
 * THE CAP, and the real invariant — no plan's included pool may exceed 40% of
 * its price.
 *
 * This replaces a "one rule, 30%" claim that every plan had already overridden,
 * which is the failure mode a derived default has: once each row pins its own
 * number the rule describes nothing. A CAP survives that, because it constrains
 * the overrides instead of competing with them, and `plans.test.ts` asserts it.
 *
 * 40% is a solvency cap, not the launch-margin target. A granted credit costs
 * `openRouterCreditPurchaseCostUsd(pool)` (OpenRouter's 5.5% plus the current
 * Singapore GST reserve), the free node has a plan-specific reserve,
 * and Polar has a percentage plus fixed subscription fee. ANNUAL is the binding
 * case because a yearly plan bills 10 months while serving 12 pool grants.
 * The economics guard separately requires each current yearly offer to clear a
 * 20% contribution-margin floor; a plan can be solvent and still be too thin
 * to launch.
 *
 * The old 75% Max override is exactly what this forbids: $2000/yr against 12 ×
 * $150 of credits was a LOSS at full list price before any discount existed.
 */
export const INCLUDED_CREDIT_FRACTION_MAX = 0.4;

/**
 * Derive a plan's monthly included credit pool from its recurring price. Returns
 * integer micro-USD = round(price * fraction); 0 when there is no recurring
 * price. A per-seat plan may use this helper for a per-seat pool, while Teams'
 * current version uses a fixed organization pool per five billed seats; the
 * scaling decision is applied by `resolveEntitlement` from the plan row.
 */
export const includedCreditPoolMicroUsd = (
	monthlyPriceMicroUsd: number,
	fraction: number = INCLUDED_CREDIT_FRACTION_DEFAULT
): number => {
	if (monthlyPriceMicroUsd <= 0) {
		return 0;
	}
	return Math.round(monthlyPriceMicroUsd * fraction);
};
