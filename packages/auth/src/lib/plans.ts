/**
 * Plan catalog: the single source of truth for Ryu's subscription / license
 * plans (epic #496 — Ryu Cloud + organization pricing, Unit 0).
 *
 * CLAUDE.md placement rule (§1): "what is allowed, shared, measured, or paid
 * for" is control-plane. Plans decide *what a user is entitled to* (desktop
 * access, managed inference, included credit pool, seats), so they live next to
 * billing in `@ryu/auth`.
 *
 * NOTHING HARDCODED: every Polar product/price id reads from an env var with a
 * documented placeholder default. The dollar figures (credit pools, deposit
 * fee) live ONLY here and nowhere else in the codebase. To swap a plan's
 * pricing you change one row in this file; to swap a Polar product you set its
 * env var. See `docs/polar-products.md` for the products/prices/benefits that
 * must be created in Polar and which env vars carry their ids.
 *
 * Pricing decisions (defaults, unified organization catalog, 2026-08-19):
 *  - Desktop license  one-time $200 list (launch $129 via the LIFETIME129 discount;
 *                     Polar license-key benefit, 7-day trial, 1yr updates).
 *                     Grants desktop access, NO managed inference.
 *  - A Major Pass      $20/month or $200/year for one individual user;
 *                     supported paid Marketplace access and publisher-pool funding.
 *  - Pro              $49/mo individual plan; shown on the public individual
 *                     shelf; fixed $15 pool. Existing $39 contracts remain
 *                     grandfathered at their recorded pricing version.
 *  - Max              $99/mo individual plan; shown on the public individual
 *                     shelf; fixed $30 pool.
 *  - Teams            $50/member seat/mo, five-seat minimum ($250 floor),
 *                     organization-owned; pooled credits grow by $50 per five
 *                     billed seats in the current pricing version.
 *  - Business         $300/month for five seats, then $50 per seat; pooled
 *                     credits grow by $100 per completed five-seat bundle.
 *  - Credits top-up   deposit fee 17% base (16.5% Pro, 16% Max/org) + $2.75
 *                     floor; usage debits AT COST (markup 0).
 *
 * The credit pool / markup is captured at DEPOSIT, not per-usage. The wallet is
 * USD-denominated in micro-USD (millionths of a dollar) to match
 * `CreditWallet.balanceMicroUsd`.
 *
 * Usage that debits at cost is BOTH model tokens (reason `gateway_usage`,
 * OpenRouter pass-through) AND tool calls. Composio is not free — it charges per
 * action execution — so each executed `composio.*` tool call debits the wallet
 * at cost under reason `composio`, separately from the token debit. The managed
 * gateway meters tool calls and the per-call rate is provisioned per managed node
 * (`GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD`); builtin/MCP/app tools are free.
 */

import {
	BUSINESS_SEAT_PRICE_TIERS,
	type PlanSeatPriceTier,
	seatPriceMicroUsdForSeats,
} from "./plan-seat-pricing.ts";

// One micro-USD is a millionth of a dollar; the unit the credit wallet stores.
const MICRO_USD_PER_USD = 1_000_000;

/** Convert whole USD (may be fractional) to integer micro-USD. */
export const usdToMicro = (usd: number): number =>
	Math.round(usd * MICRO_USD_PER_USD);

/** Lifetime list and launch prices shared by checkout, Polar provisioning, and UI. */
export const LIFETIME_LIST_PRICE_USD = 200;
export const LIFETIME_LAUNCH_PRICE_USD = 129;

/** The plan identifiers. `none` is the un-entitled free baseline. */
export const PLAN_IDS = [
	"desktop-license",
	"marketplace-membership",
	"pro",
	"max",
	"teams",
	"business",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Organization-owned recurring plans that use human member seats. */
export const ORGANIZATION_PLAN_IDS = ["teams", "business"] as const;
export type OrganizationPlanId = (typeof ORGANIZATION_PLAN_IDS)[number];

export const isOrganizationPlanId = (
	value: unknown
): value is OrganizationPlanId =>
	typeof value === "string" &&
	(ORGANIZATION_PLAN_IDS as readonly string[]).includes(value);

/** A plan's billing interval offerings. */
export type BillingInterval = "one_time" | "monthly" | "yearly";

/** How seats are counted for a plan. */
export type SeatModel =
	| { kind: "single" } // one fixed entitlement per buyer; hosted member limits are separate
	| { kind: "per_seat"; minSeats: number }; // billed per user/seat

/** Whether the included managed-inference pool is fixed or grows with seats. */
export type CreditPoolModel =
	| "fixed"
	| "per_seat"
	| "per_bundle"
	| "per_completed_bundle";

/** Whether a recurring plan is for one person's workspace or an organization. */
export type PlanAudience = "individual" | "organization";

/**
 * A Polar product binding. The product id reads from env with the documented
 * fallback for the active catalog. A missing/placeholder id is still a valid
 * string so imports never crash; the checkout layer is responsible for
 * refusing a placeholder id.
 */
export interface PolarBinding {
	/** Documented fallback product id for this offering. */
	readonly productIdDefault: string;
	/** Env var that carries the real Polar product id for this offering. */
	readonly productIdEnv: string;
}

/** Resolve a binding's product id from env, falling back to the default. */
export const resolveProductId = (
	binding: PolarBinding,
	read: (key: string) => string | undefined = (k) => process.env[k]
): string => read(binding.productIdEnv) ?? binding.productIdDefault;

/** A plan in the catalog. */
export interface Plan {
	/** Marginal monthly price after the base seat count, when graduated. */
	readonly additionalSeatPriceMicroUsd?: number;
	/** The ownership boundary that the checkout and entitlement must preserve. */
	readonly audience: PlanAudience;
	/** Total monthly price at the plan's minimum seat count, when graduated. */
	readonly baseMonthlyPriceMicroUsd?: number;
	/** The Polar bindings, keyed by interval this plan offers. */
	readonly bindings: Partial<Record<BillingInterval, PolarBinding>>;
	/** Number of seats represented by one pool grant for a per-bundle plan. */
	readonly creditPoolBundleSize?: number;
	/** Whether the included credit pool scales with the billed seat count. */
	readonly creditPoolModel: CreditPoolModel;
	/** Whether holding this plan unlocks the desktop app. */
	readonly desktopAccess: boolean;
	/**
	 * Whether this plan may REMOVE the "Sent from Ryu" branding footer from
	 * outbound agent email. The footer is a growth loop (every agent email markets
	 * Ryu to a non-user), so it is ON by default for everyone; only paid plans may
	 * toggle it off. Trial/free senders stay branded — they are the distribution.
	 * The toggle itself is per-inbox (`Inbox.brandingRemoved`); this is the plan
	 * capability that gates whether the toggle is allowed at all.
	 */
	readonly emailBrandingRemovable: boolean;
	/**
	 * Whether this plan includes Agent Inboxes (Ryu Mail — the AgentMail-style
	 * email-as-a-service over AWS SES: store inboxes, receive + send email).
	 * The free baseline and managed recurring plans include it; the apps-only
	 * A Major Pass and the desktop license remain without hosted mail.
	 */
	readonly emailEnabled: boolean;
	/**
	 * Max number of Agent Inboxes the plan may create (0 when disabled). The free
	 * baseline allows one inbox; managed plans (pro/max/teams/business) allow
	 * UNLIMITED inboxes ({@link Number.POSITIVE_INFINITY}); the cap is on
	 * STORAGE ({@link emailStorageLimitGb}), not count. A Major Pass has no mail.
	 */
	readonly emailInboxLimit: number;
	/** Max outbound emails the plan may send per calendar month (0 when off). */
	readonly emailMonthlySendLimit: number;
	/**
	 * Max total stored Agent Inbox bytes the plan may hold, expressed in whole GB
	 * (0 when email is disabled). This — not inbox count — is what caps Agent
	 * Inboxes: free 1, desktop 0, A Major Pass 0, pro 20, max 100, teams 20,
	 * and business 20. Enforced by the mail router; the byte figure is derived
	 * via {@link emailStorageLimitBytes}.
	 */
	readonly emailStorageLimitGb: number;
	readonly id: PlanId;
	/** Whether this plan includes Ryu-managed inference (a credit pool). */
	readonly managedInference: boolean;
	/** Whether this plan unlocks supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/**
	 * Whether this recurring plan contributes to the Marketplace publisher pool.
	 * This is deliberately separate from `marketplaceApps`: access is a plan
	 * capability, while publisher funding is a commercial funding rule.
	 */
	readonly marketplacePublisherPool: boolean;
	/**
	 * Included monthly credit pool in micro-USD. The value is materialized because
	 * the version table must preserve the exact pool promised at checkout; fixed
	 * and seat-bundled contracts are not all a single percentage of price. The
	 * {@link includedCreditPoolMicroUsd} helper supplies the 30%-default fallback
	 * for plans that use a proportional pool. Refreshed each billing period.
	 */
	readonly monthlyCreditPoolMicroUsd: number;
	/**
	 * The plan's RECURRING price in micro-USD — per month for single plans, per
	 * SEAT per month for per-seat plans (Teams and Business). 0 for plans with no recurring
	 * price (the one-time desktop license). The base the included credit pool is
	 * derived from; the yearly binding's discounted price is a checkout concern
	 * and does not change the monthly grant.
	 */
	readonly monthlyPriceMicroUsd: number;
	/** Human label for surfaces. */
	readonly name: string;
	/** Seat model — single entitlement vs per-seat org plan. */
	readonly seatModel: SeatModel;
	/** Graduated per-seat prices, when a plan has more than one seat band. */
	readonly seatPriceTiers?: readonly PlanSeatPriceTier[];
}

/**
 * One-time deposit fee (markup) on credit top-ups. Ryu's PREPAID model: a
 * customer buys credits up front, then spends them — models are metered AT COST
 * (no per-token markup) and tool calls use the configured provider rate; the
 * platform's inference margin is captured once here, at deposit. Lives ONLY here.
 *
 * The fee is `max(plan % of the top-up, $2.75 floor)` — a MINIMUM, not an
 * add-on. The safe schedule is 17% for the unqualified/base rate, 16.5% for
 * Pro, and 16% for Max and organization plans. It covers the current
 * OpenRouter funding fee and the highest listed Polar card-processing path,
 * including the international-card surcharge, without adding a usage markup.
 *
 * The floor is NOT a free parameter — see {@link DEPOSIT_FEE_FIXED_MICRO_USD} for
 * why $2.75 specifically, and why lowering a managed-plan rate below 16% reopens
 * a band of deposits that lose money.
 */
export const DEPOSIT_FEE_BPS = 1700; // 17.00% base rate in basis points

/**
 * The minimum fee on any top-up. **$2.75, and the number is load-bearing.**
 *
 * The floor and percentage have to overlap under the current conservative
 * processor case: OpenRouter 5.5% with a $0.80 minimum and Polar 6.5% + $0.50
 * on a transaction. At the 16% managed-plan rate the percentage
 * curve starts clearing its own costs at about $16.89; the $2.75 floor remains
 * safe through the rounded-cent crossover. The economics test walks every
 * whole-cent value through $600 so a sampled list cannot hide a loss band.
 *
 * A $5 face value therefore costs $7.75 and a $10 face value costs $12.75 at
 * the base floor. The checkout returns the exact face, fee, and total before
 * the buyer leaves Ryu.
 */
export const DEPOSIT_FEE_FIXED_MICRO_USD = usdToMicro(2.75);

/** Current conservative external cost inputs used by the top-up economics guard. */
export const TOPUP_OPENROUTER_FEE_BPS = 550;
export const TOPUP_OPENROUTER_MINIMUM_USD = 0.8;
export const TOPUP_POLAR_PROCESSING_BPS = 650;
export const TOPUP_POLAR_PROCESSING_FIXED_USD = 0.5;

/**
 * WHY 17% / 16% — the arithmetic that sets the floor under every rate below.
 *
 * Two costs sit under every top-up, and the fee has to clear BOTH:
 *
 *  - **OpenRouter charges 5.5%**, with a current $0.80 minimum, to buy the
 *    credits we then meter out at cost (`markup_bps` is pinned to 0 on purpose).
 *  - The conservative Polar case is **6.5% + $0.50**: the current Starter
 *    transaction rate plus the listed international-card surcharge.
 *
 * The buyer pays `face + fee` and the wallet is credited `face`
 * (`computeTopupQuote`), so per top-up:
 *
 *     net = (1 − 0.065) × fee − (0.055 + 0.065) × face − 0.50
 *
 * The 16% managed-plan rate and $2.75 floor are the smallest rounded schedule
 * in this catalog that stays non-negative through the floor/percentage join in
 * that conservative case. The fee is the only Ryu spread on inference; usage
 * remains at cost.
 *
 * The 16% managed-plan rate clears it with room for the international-card
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
	const minimumRegimeBoundary = TOPUP_OPENROUTER_MINIMUM_USD / openRouterRate;
	const minimumRegimeRate = rate * (1 - polarRate) - polarRate;
	const minimumRegimeBreakEven =
		minimumRegimeRate > 0
			? (TOPUP_OPENROUTER_MINIMUM_USD + TOPUP_POLAR_PROCESSING_FIXED_USD) /
				minimumRegimeRate
			: Number.POSITIVE_INFINITY;
	if (minimumRegimeBreakEven <= minimumRegimeBoundary) {
		return minimumRegimeBreakEven;
	}
	const percentageRegimeRate =
		rate * (1 - polarRate) - (openRouterRate + polarRate);
	return percentageRegimeRate > 0
		? TOPUP_POLAR_PROCESSING_FIXED_USD / percentageRegimeRate
		: Number.POSITIVE_INFINITY;
};

/**
 * Deposit-fee rate (bps) by active plan.
 *
 * TOP-UPS REQUIRE A SUBSCRIPTION. `POST /api/credits/topup` refuses any
 * entitlement without `managedInference`, so free users AND Lifetime licence
 * holders cannot top up at all — renting Ryu's keys is a subscription feature,
 * and letting a one-time $129 desktop licence buy credits forever would make Pro
 * pointless. The `desktop-license` row below is therefore UNREACHABLE in
 * practice; it exists so the map is total over `PlanId` and a future policy
 * change has an obvious place to land, not because Lifetime has a rate.
 *
 * Pro pays 16.5%. Max, Teams, and Business pay 16%. All are below the 17% base
 * rate while remaining above the conservative break-even.
 */
export const DEPOSIT_FEE_BPS_BY_PLAN: Record<PlanId, number> = {
	"desktop-license": DEPOSIT_FEE_BPS, // total map; route does not allow this plan to top up
	"marketplace-membership": DEPOSIT_FEE_BPS,
	pro: 1650,
	max: 1600,
	teams: 1600,
	business: 1600,
};

/** The deposit-fee rate (bps) for a buyer on `plan`, falling back to the base rate. */
export const depositFeeBps = (plan: PlanId | null): number =>
	plan ? (DEPOSIT_FEE_BPS_BY_PLAN[plan] ?? DEPOSIT_FEE_BPS) : DEPOSIT_FEE_BPS;

/**
 * The deposit fee on a top-up of `amountMicroUsd` for a buyer on `plan`: the
 * GREATER of the (plan-discounted) percentage and the fixed minimum floor. The
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
	return Math.max(variable, DEPOSIT_FEE_FIXED_MICRO_USD);
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
 * `pool × 1.055` (OpenRouter's 5.5%), the free node has a plan-specific reserve,
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

/**
 * The map keyed by plan → recurring list price (micro-USD): per month for single
 * plans, per SEAT per month for Teams and Business. The one-time desktop license has no
 * recurring price (0). These are the ONLY plan-price figures in the codebase;
 * the included credit grant is DERIVED from them by
 * {@link includedCreditPoolMicroUsd}, never hand-typed per row.
 */
export const PLAN_MONTHLY_PRICE_MICRO_USD: Record<PlanId, number> = {
	"desktop-license": 0, // one-time list price; no recurring price
	"marketplace-membership": usdToMicro(20),
	pro: usdToMicro(49),
	max: usdToMicro(99),
	// Per-seat list price. Five Teams seats therefore start at $250/mo.
	teams: usdToMicro(50),
	// Business's first graduated band is $60/seat for five seats ($300/mo);
	// subsequent seats use the tiered price recorded below.
	business: usdToMicro(60),
};

/* -------------------------------------------------------------------------- *
 * PLAN VERSIONS — what a subscriber bought, not what we sell today.
 * -------------------------------------------------------------------------- */

/** One historical (price, pool) pairing for a plan. Append-only. */
export interface PlanVersion {
	/** Marginal price after the version's base seat count, when graduated. */
	readonly additionalSeatPriceMicroUsd?: number;
	/** Total price at the version's minimum seat count, when graduated. */
	readonly baseMonthlyPriceMicroUsd?: number;
	/** Bundle size for a bundled historical pool. */
	readonly creditPoolBundleSize?: number;
	/** Historical pool scaling, when it differs from the current plan model. */
	readonly creditPoolModel?: CreditPoolModel;
	/** Included pool per month; scaling is controlled by this row or the live plan. */
	readonly monthlyCreditPoolMicroUsd: number;
	/** List price when this version was sold, per month / per seat. */
	readonly monthlyPriceMicroUsd: number;
	/** Graduated seat prices for this historical/current version, when any. */
	readonly seatPriceTiers?: readonly PlanSeatPriceTier[];
	/** Monotonic; 1 is the original. */
	readonly version: number;
}

/**
 * THE GRANDFATHERING TABLE, and the reason it has to exist.
 *
 * Polar already grandfathers the PRICE: a checkout pins the amount onto the
 * subscription, so changing a product's price never touches anyone who already
 * bought. That half is free and always worked.
 *
 * The POOL was not grandfathered at all. `resolveEntitlement` read
 * `plan.monthlyCreditPoolMicroUsd` off the live catalog on every call, keyed
 * only by product id, so the moment the pool was raised for new buyers it rose
 * for EVERY existing subscriber — including the ones still paying the old, lower
 * price. That is the exact inverse of grandfathering, and it is a loss, not a
 * trimmed margin: a $39 Pro subscriber handed a $25 pool clears $4.54/mo and
 * **−$15.61 on the annual plan**.
 *
 * So a version records the pair. A subscription carries its version in
 * server-set Polar checkout metadata, and its entitlement resolves from THAT
 * row. Raising the pool in v2 then cannot reach a v1 subscriber.
 *
 * NOTHING IS BEING MIGRATED HERE. Production had zero subscriptions of any
 * status when this shipped, so v1 is not a legacy population to protect — it is
 * the cohort we START accumulating today, and every one of them is stamped at
 * checkout. The machinery is inert until v2 exists; that is the point of adding
 * it before the price rise rather than during it.
 *
 * APPEND ONLY. Never edit a shipped row — someone is still being billed against
 * it, and rewriting history is how a grandfathered customer silently starts
 * losing money. To change pricing, push a new row and bump
 * {@link CURRENT_PLAN_VERSION}.
 *
 * NODE TYPE IS DELIBERATELY NOT VERSIONED. `BASE_NODE_TYPE_BY_PLAN` is keyed by
 * plan, so upgrading a plan's machine upgrades it for grandfathered subscribers
 * too. That is a choice: hardware is a benefit we are happy to hand everyone,
 * and the margin model in `plan-economics.test.ts` charges EVERY version the
 * CURRENT node cost, which is the conservative direction — it can only
 * understate margin, never overstate it.
 */
export const PLAN_VERSIONS: Record<PlanId, readonly PlanVersion[]> = {
	"desktop-license": [
		{ version: 1, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 2, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 3, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 4, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
		{ version: 5, monthlyPriceMicroUsd: 0, monthlyCreditPoolMicroUsd: 0 },
	],
	"marketplace-membership": [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(9.99),
			monthlyCreditPoolMicroUsd: 0,
		},
		{
			// A Major Pass launch price. Earlier subscribers stay on their
			// immutable $9.99 snapshots.
			version: 6,
			monthlyPriceMicroUsd: usdToMicro(20),
			monthlyCreditPoolMicroUsd: 0,
		},
	],
	pro: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
		},
		{
			// New Pro contracts move to the margin-safe $49/$490 ladder. Older
			// contracts remain pinned to the price and pool in their version row.
			version: 6,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
		},
	],
	max: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(2500),
			monthlyCreditPoolMicroUsd: usdToMicro(250),
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(2500),
			monthlyCreditPoolMicroUsd: usdToMicro(250),
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(99),
			monthlyCreditPoolMicroUsd: usdToMicro(30),
		},
	],
	teams: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 3,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			creditPoolModel: "fixed",
		},
		{
			version: 4,
			monthlyPriceMicroUsd: usdToMicro(250),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
			creditPoolModel: "fixed",
		},
		{
			version: 5,
			monthlyPriceMicroUsd: usdToMicro(50),
			monthlyCreditPoolMicroUsd: usdToMicro(50),
			creditPoolModel: "per_bundle",
			creditPoolBundleSize: 5,
		},
	],
	business: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(60),
			monthlyCreditPoolMicroUsd: usdToMicro(100),
			creditPoolModel: "per_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: BUSINESS_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(300),
			additionalSeatPriceMicroUsd: usdToMicro(50),
		},
		{
			// Current Business contracts grant one pool for each COMPLETED
			// five-seat bundle: 5–9 seats receive $100, 10–14 receive $200.
			// v1 remains append-only for any grandfathered subscriber.
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(60),
			monthlyCreditPoolMicroUsd: usdToMicro(100),
			creditPoolModel: "per_completed_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: BUSINESS_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(300),
			additionalSeatPriceMicroUsd: usdToMicro(50),
		},
	],
};

/** The version a NEW checkout is stamped with. Bump when adding a row. */
export const CURRENT_PLAN_VERSION = 5;

/** Current immutable pricing snapshot per recurring plan. */
export const CURRENT_PLAN_VERSION_BY_PLAN: Record<PlanId, number> = {
	"desktop-license": 4,
	"marketplace-membership": 6,
	pro: 6,
	max: 4,
	teams: 5,
	business: 2,
};

export const currentPlanVersionFor = (plan: PlanId): number =>
	CURRENT_PLAN_VERSION_BY_PLAN[plan];

/**
 * The version row for `plan`, or the OLDEST row when the version is unknown.
 *
 * Falling back to v1 rather than the newest is a FAIL-SAFE, not a migration
 * path: no unstamped subscription has ever existed (production was empty when
 * versioning shipped, and every checkout has stamped since). It matters only if
 * metadata is ever lost or a subscription arrives from a path that forgets to
 * stamp — and in that case the cheap answer is the safe one, because handing out
 * the NEWEST pool to a subscription of unknown vintage is how a grandfathered
 * customer silently starts losing money.
 */
export const planVersionFor = (
	plan: PlanId,
	version?: number | string | null
): PlanVersion => {
	const rows = PLAN_VERSIONS[plan];
	const wanted = Number(version);
	if (Number.isFinite(wanted)) {
		const hit = rows.find((r) => r.version === wanted);
		if (hit) {
			return hit;
		}
	}
	return rows[0] as PlanVersion;
};

/** Resolve the historical/current pool model for one plan version. */
export const creditPoolModelForVersion = (
	plan: Plan,
	version: PlanVersion
): CreditPoolModel => version.creditPoolModel ?? plan.creditPoolModel;

/**
 * Calculate the monthly included pool for a plan at a billed seat count.
 *
 * Teams v5 uses a five-seat bundle: five billed seats receive $50, ten receive
 * $100, and so on. Current Business uses completed bundles: five through nine
 * billed seats receive $100, ten through fourteen receive $200, and so on. The
 * version row owns the scaling rule so older contracts remain grandfathered
 * when the public offer changes.
 */
export const monthlyCreditPoolMicroUsdForSeats = (input: {
	plan: Plan;
	version: PlanVersion;
	seats: number;
}): number => {
	const seats = Number.isFinite(input.seats)
		? Math.max(1, Math.floor(input.seats))
		: 1;
	const model = creditPoolModelForVersion(input.plan, input.version);
	if (model === "fixed") {
		return input.version.monthlyCreditPoolMicroUsd;
	}
	if (model === "per_seat") {
		return input.version.monthlyCreditPoolMicroUsd * seats;
	}
	const bundleSize = Math.max(
		1,
		Math.floor(
			input.version.creditPoolBundleSize ??
				input.plan.creditPoolBundleSize ??
				(input.plan.seatModel.kind === "per_seat"
					? input.plan.seatModel.minSeats
					: 1)
		)
	);
	const bundleCount =
		model === "per_completed_bundle"
			? Math.max(1, Math.floor(seats / bundleSize))
			: Math.ceil(seats / bundleSize);
	return input.version.monthlyCreditPoolMicroUsd * bundleCount;
};

/** Calculate the actual recurring price for one plan at one billed seat count. */
export const monthlyPriceMicroUsdForSeats = (input: {
	plan: Plan;
	version?: PlanVersion;
	seats: number;
}): number => {
	const minimum =
		input.plan.seatModel.kind === "per_seat"
			? input.plan.seatModel.minSeats
			: 1;
	const seats = Number.isFinite(input.seats)
		? Math.max(minimum, Math.floor(input.seats))
		: minimum;
	const tiers = input.version?.seatPriceTiers ?? input.plan.seatPriceTiers;
	if (tiers) {
		return seatPriceMicroUsdForSeats(tiers, seats);
	}
	const monthlyPriceMicroUsd =
		input.version?.monthlyPriceMicroUsd ?? input.plan.monthlyPriceMicroUsd;
	if (input.plan.seatModel.kind === "per_seat") {
		return monthlyPriceMicroUsd * seats;
	}
	return monthlyPriceMicroUsd;
};

/**
 * The free plan-specific managed cloud node is included with every recurring
 * managed plan in a supported/default region: Pro `cx23`, Max `cx33`, Teams
 * `cx43`, and Business `cx53` in the EU default region. Pro and Max do not
 * promise a free regional node in Singapore because those shapes exceed their
 * safe annual cost envelope; Teams and Business use their available regional
 * fallbacks. The server-side location resolver owns that exception. The node's
 * compute cost is absorbed into the plan price; there is no separate Polar
 * product for an included node, so holding a qualifying subscription is what
 * grants it. Any other instance is a dynamically-priced, ad-hoc paid
 * cloud-instance subscription on top, gated by `hasActiveCloudInstanceSub` in
 * `plan-entitlement.ts`.
 *
 * The set + predicate live in the client-safe sibling `./base-node.ts`
 * (`PLANS_INCLUDING_BASE_NODE` / `planIncludesBaseNode` / the copy label). They
 * are NOT here on purpose: the pricing page and org dashboard are client trees
 * and must not pull this catalog — every Polar product id and env-var name —
 * into the browser to read one predicate. This replaced a
 * `MAX_INCLUDES_BASE_CLOUD = true` constant that nothing ever imported, while
 * two separate call sites hardcoded the literal `"max"` and drifted apart.
 */

/**
 * The plan catalog. Product id DEFAULTS reference the existing sandbox UUIDs in
 * `constants.ts` where a matching product already exists (pro/max monthly+
 * yearly, lifetime → reused as the desktop license placeholder). Business,
 * Teams, and desktop license bindings that need NEW Polar products use a
 * clearly-fake
 * placeholder default ("polar_product_<slug>") so a misconfigured deploy fails
 * loudly rather than silently charging the wrong product. See
 * `docs/polar-products.md`.
 */
export const PLANS: Record<PlanId, Plan> = {
	"desktop-license": {
		audience: "individual",
		id: "desktop-license",
		name: "Ryu Desktop",
		desktopAccess: true,
		marketplaceApps: false,
		marketplacePublisherPool: false,
		managedInference: false,
		// One-time $200 list license — no RECURRING price, so the default fraction derives a 0
		// monthly grant (no managed inference).
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD["desktop-license"],
		monthlyCreditPoolMicroUsd: includedCreditPoolMicroUsd(
			PLAN_MONTHLY_PRICE_MICRO_USD["desktop-license"]
		),
		emailEnabled: false,
		emailInboxLimit: 0,
		emailMonthlySendLimit: 0,
		emailStorageLimitGb: 0,
		emailBrandingRemovable: false,
		seatModel: { kind: "single" },
		bindings: {
			// One-time $200 list ($129 launch) with a Polar license-key benefit + 7-day trial. Defaults
			// to the existing "lifetime" sandbox product until a dedicated
			// desktop-license product is created (see docs).
			one_time: {
				productIdEnv: "POLAR_PRODUCT_DESKTOP_LICENSE",
				productIdDefault: "e689e9bc-2535-4571-9573-8e11e188bf52",
			},
		},
		creditPoolModel: "fixed",
	},
	"marketplace-membership": {
		audience: "individual",
		id: "marketplace-membership",
		name: "A Major Pass",
		desktopAccess: false,
		marketplaceApps: true,
		managedInference: false,
		monthlyPriceMicroUsd:
			PLAN_MONTHLY_PRICE_MICRO_USD["marketplace-membership"],
		monthlyCreditPoolMicroUsd: 0,
		marketplacePublisherPool: true,
		emailEnabled: false,
		emailInboxLimit: 0,
		emailMonthlySendLimit: 0,
		emailStorageLimitGb: 0,
		emailBrandingRemovable: false,
		// A Major Pass is for one individual user. Shared Marketplace access is
		// not an organization-seat product; teams should use Teams or Business.
		seatModel: { kind: "single" },
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_MARKETPLACE_MEMBERSHIP_MONTHLY",
				productIdDefault: "fc584f73-9eb9-4e2a-8a94-3f6463734ea2",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_MARKETPLACE_MEMBERSHIP_YEARLY",
				productIdDefault: "polar_product_marketplace_membership_yearly",
			},
		},
		creditPoolModel: "fixed",
	},
	pro: {
		audience: "individual",
		id: "pro",
		name: "Ryu Pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		// Ryu Pro — the current $49/mo individual plan. It is for one person's
		// managed workspace; shared organization ownership belongs to Teams.
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD.pro,
		monthlyCreditPoolMicroUsd: usdToMicro(15),
		marketplacePublisherPool: false,
		// Agent Inboxes: UNLIMITED count for a personal workspace; capped by 20 GB
		// of stored mail (emailStorageLimitGb), not by inbox count.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 10_000,
		emailStorageLimitGb: 20,
		// Paid: may drop the "Sent from Ryu" footer (per-inbox toggle, off by default).
		emailBrandingRemovable: true,
		seatModel: { kind: "single" },
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_PRO_MONTHLY",
				productIdDefault: "ecf08edd-a677-4a6e-a618-53918e282298",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_PRO_YEARLY",
				productIdDefault: "05b73727-21e8-4e0f-82bf-cb6e3b2e848c",
			},
		},
		creditPoolModel: "fixed",
	},
	max: {
		audience: "individual",
		id: "max",
		name: "Ryu Max",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		// Ryu Max — the original $99/mo individual power plan. The public business
		// automation offer is Teams; Max is not a substitute for shared ownership.
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD.max,
		monthlyCreditPoolMicroUsd: usdToMicro(30),
		marketplacePublisherPool: false,
		// Agent Inboxes: UNLIMITED count; capped by 100 GB of stored mail.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 100_000,
		emailStorageLimitGb: 100,
		emailBrandingRemovable: true,
		// A Max subscription is personal even though the surrounding billing system
		// also supports organization-scoped hosted-agent contracts with the `max`
		// id. Keep the legacy seat model single so the fixed personal pool is never
		// multiplied by a member count.
		seatModel: { kind: "single" },
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_MAX_MONTHLY",
				productIdDefault: "6c238194-0b03-4964-8947-9c586d05b6a9",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_MAX_YEARLY",
				productIdDefault: "d4cc175d-a301-4e56-b677-1542bf160a79",
			},
		},
		creditPoolModel: "fixed",
	},
	teams: {
		audience: "organization",
		id: "teams",
		name: "Ryu Teams",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		// The public business offer is member-seat based: $50/seat/mo with a
		// five-seat floor ($250/mo). The current credit grant is pooled at the
		// organization level and grows by $50 for each additional five billed seats.
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD.teams,
		monthlyCreditPoolMicroUsd: usdToMicro(50),
		marketplacePublisherPool: false,
		// Agent Inboxes: UNLIMITED count; capped by a flat org-wide 20 GB of stored
		// mail.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 100_000,
		emailStorageLimitGb: 20,
		emailBrandingRemovable: true,
		seatModel: { kind: "per_seat", minSeats: 5 },
		creditPoolModel: "per_bundle",
		creditPoolBundleSize: 5,
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_TEAMS_MONTHLY",
				productIdDefault: "polar_product_teams_monthly",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_TEAMS_YEARLY",
				productIdDefault: "polar_product_teams_yearly",
			},
		},
	},
	business: {
		audience: "organization",
		id: "business",
		name: "Ryu Business",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD.business,
		monthlyCreditPoolMicroUsd: usdToMicro(100),
		marketplacePublisherPool: false,
		seatPriceTiers: BUSINESS_SEAT_PRICE_TIERS,
		baseMonthlyPriceMicroUsd: usdToMicro(300),
		additionalSeatPriceMicroUsd: usdToMicro(50),
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 100_000,
		emailStorageLimitGb: 20,
		emailBrandingRemovable: true,
		seatModel: { kind: "per_seat", minSeats: 5 },
		creditPoolModel: "per_completed_bundle",
		creditPoolBundleSize: 5,
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_BUSINESS_MONTHLY",
				productIdDefault: "polar_product_business_monthly",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_BUSINESS_YEARLY",
				productIdDefault: "polar_product_business_yearly",
			},
		},
	},
};

/** All plans as an array, for iteration. */
export const ALL_PLANS: readonly Plan[] = Object.values(PLANS);

/* -------------------------------------------------------------------------- *
 * Bucket-3 numeric quotas (free-tier gating plan, 2026-07-11)
 *
 * Deliberately SMALL starter caps and SYMBOLIC: enforced only on the managed path +
 * desktop client, never in OSS core/gateway (self-host stays uncapped).
 *
 * These used to be fourteen hand-written fields on {@link Plan}, repeated once
 * per tier, plus a hand-written union that had to be kept in sync with the free
 * baseline by eye. That made a quota a CORE-AUTH concern: shipping an app with a
 * limit meant editing the billing catalog, which is the same hardcoding the
 * `data_categories` contribution removed from the Danger Zone. So a quota is now
 * a DECLARATION ({@link QuotaSpec}) and the tiers are derived from it.
 *
 * The split mirrors `data_categories` exactly, and for the same reason: the
 * manifest owns *whether the key exists and what it means*, this file owns *what
 * the numbers are*. Numbers must never move into a manifest — an app that could
 * write its own tier row would simply grant itself unlimited everything.
 * -------------------------------------------------------------------------- */

/**
 * What a quota's number counts, so a surface can render it without a lookup
 * table of its own: "5 monitors" vs "30 days" vs "2 GB".
 */
export type QuotaUnit = "count" | "days" | "gigabytes";

/** One numeric quota: what it means, who owns the key, and its per-tier numbers. */
export interface QuotaSpec {
	/** The FREE (null-plan) baseline — the managed starter cap. */
	readonly free: number;
	/** Human label for upgrade prompts and the pricing grid ("Website monitors"). */
	readonly label: string;
	/**
	 * The app id whose manifest declares this key, or `null` when the KERNEL owns
	 * it. A kernel quota is a shell/runtime concern with no app to uninstall, so it
	 * always applies; an app-owned quota applies only while that app is installed
	 * and enabled (the client resolves that — see the desktop `planCapBridge`).
	 */
	readonly owner: string | null;
	/**
	 * Per-plan numbers. A plan absent from this map is UNBOUNDED
	 * ({@link Number.POSITIVE_INFINITY}) — which is the symbolic-cap default, so
	 * only a quota with a real per-tier cost writes a row here.
	 */
	readonly paid?: Partial<Record<PlanId, number>>;
	readonly unit: QuotaUnit;
}

/**
 * Quotas owned by the desktop shell or Core runtime. Marketplace apps, plugins,
 * skills, MCP servers, and workflows are intentionally absent: their catalog
 * price is commerce metadata and must not become a plan-based runtime limit.
 */
export const KERNEL_QUOTAS = {
	maxAgents: { free: 3, label: "Agents", owner: null, unit: "count" },
	maxConcurrentRuns: {
		free: 1,
		label: "Concurrent runs",
		owner: null,
		// The one REAL compute lever, so it stays finite even on paid rows.
		paid: {
			"desktop-license": 3,
			pro: 3,
			max: 3,
			teams: 8,
			business: 8,
		},
		unit: "count",
	},
	maxEvalRunsMonthly: {
		free: 10,
		label: "Eval runs per month",
		owner: null,
		unit: "count",
	},
	maxOpenTabs: { free: 3, label: "Open tabs", owner: null, unit: "count" },
	maxRemoteNodes: {
		free: 1,
		label: "Remote nodes",
		owner: null,
		unit: "count",
	},
	maxSpaces: { free: 1, label: "Spaces", owner: null, unit: "count" },
	spaceStorageLimitGb: {
		free: 1,
		label: "Space storage",
		owner: null,
		// Real storage cost, so finite on paid rows too.
		paid: {
			"desktop-license": 20,
			pro: 20,
			max: 50,
			teams: 50,
			business: 50,
		},
		unit: "gigabytes",
	},
} as const satisfies Record<string, QuotaSpec>;

/**
 * Every declared Core quota key. DERIVED from the registry above — never
 * hand-written, and never widened to `string`: call sites pass string literals
 * (`guard("maxSpaces", n)`), so a widened union would keep every one of them
 * compiling while silently losing the typo check that is the point.
 */
export type PlanLimitField = keyof typeof KERNEL_QUOTAS;

/** The single registry of plan quotas that remain after app/plugin access opens. */
export const QUOTAS: Readonly<Record<PlanLimitField, QuotaSpec>> = {
	...KERNEL_QUOTAS,
};

/** Retained for callers that render quota ownership; remaining keys are Core-owned. */
export const quotaOwner = (field: PlanLimitField): string | null =>
	QUOTAS[field].owner;

/**
 * The FREE (null-plan) baseline for every quota, projected out of {@link QUOTAS}.
 * Kept as an exported record because consumers iterate it; the numbers themselves
 * live on each {@link QuotaSpec}. Read it through {@link planLimit}, never inline.
 */
export const FREE_TIER_LIMITS: Readonly<Record<PlanLimitField, number>> =
	Object.fromEntries(
		Object.entries(QUOTAS).map(([field, spec]) => [field, spec.free])
	) as Record<PlanLimitField, number>;

/**
 * The effective numeric limit for `field` on `plan`. A null plan gets the free
 * baseline; a paid plan gets its {@link QuotaSpec.paid} row, defaulting to
 * unbounded. Single source of truth for every count/quota gate — enforce with
 * this, never a literal.
 *
 * This answers "what does this tier allow" for the remaining Core-owned
 * resource limits. Marketplace app/plugin access is not represented here.
 */
export const planLimit = (
	plan: PlanId | null,
	field: PlanLimitField
): number => {
	const spec = QUOTAS[field];
	if (!plan) {
		return spec.free;
	}
	return spec.paid?.[plan] ?? Number.POSITIVE_INFINITY;
};

/** Bytes in one gibibyte; the unit the storage cap is expressed against. */
const BYTES_PER_GB = 1024 ** 3;

/** Free baseline hosted-mail storage, kept small to bound inbound abuse. */
export const FREE_EMAIL_STORAGE_LIMIT_GB = 1;

/**
 * The total stored-mail cap (in bytes) a plan grants for Agent Inboxes, derived
 * from its {@link Plan.emailStorageLimitGb}. A null plan receives the free
 * baseline's 1 GiB storage allowance.
 * An unbounded GB figure ({@link Number.POSITIVE_INFINITY}) maps straight to
 * Infinity (no byte multiply). Single source of truth; never inline the multiply
 * in the mail router.
 */
export const emailStorageLimitBytes = (plan: PlanId | null): number => {
	const gb = plan
		? PLANS[plan].emailStorageLimitGb
		: FREE_EMAIL_STORAGE_LIMIT_GB;
	return gb === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: gb * BYTES_PER_GB;
};

/** The Agent Inboxes (Ryu Mail) quota a plan grants. */
export interface EmailQuota {
	/** Whether Agent Inboxes are available at all on this plan. */
	readonly enabled: boolean;
	/**
	 * Max inboxes the plan may hold. Free has one; paid plans are UNLIMITED
	 * ({@link Number.POSITIVE_INFINITY}); enforcement caps STORAGE, not count.
	 */
	readonly inboxLimit: number;
	/** Max outbound emails per calendar month. */
	readonly monthlySendLimit: number;
	/**
	 * Max total stored Agent Inbox bytes the plan may hold (the real Agent Inbox
	 * cap). {@link Number.POSITIVE_INFINITY} means uncapped; all current plans are
	 * finite.
	 */
	readonly storageLimitBytes: number;
}

/** The disabled email quota used by plans that have no hosted mail entitlement. */
export const EMAIL_QUOTA_NONE: EmailQuota = {
	enabled: false,
	inboxLimit: 0,
	monthlySendLimit: 0,
	storageLimitBytes: 0,
};

/**
 * The free growth-loop allowance. Fifty sends is enough for a real agent to
 * reach a small audience without turning a free account into a bulk-mail
 * account. It is intentionally branded and capped to one inbox; paid tiers
 * buy materially more volume and storage.
 */
export const EMAIL_QUOTA_FREE: EmailQuota = {
	enabled: true,
	inboxLimit: 1,
	monthlySendLimit: 50,
	storageLimitBytes: emailStorageLimitBytes(null),
};

/**
 * Resolve the Agent Inboxes quota for a plan id. A null plan (the free
 * baseline) gets {@link EMAIL_QUOTA_FREE}. The numbers live ONLY in the plan
 * catalog above — never inline them in the mail router or the pricing page (that
 * page's strings are marketing copy; THIS is the enforced limit).
 */
export const emailQuotaForPlan = (plan: PlanId | null): EmailQuota => {
	if (!plan) {
		return EMAIL_QUOTA_FREE;
	}
	const p = PLANS[plan];
	return {
		enabled: p.emailEnabled,
		inboxLimit: p.emailInboxLimit,
		monthlySendLimit: p.emailMonthlySendLimit,
		storageLimitBytes: emailStorageLimitBytes(plan),
	};
};

/**
 * Whether a plan may remove the "Sent from Ryu" branding footer from outbound
 * agent email. A null plan (free/trial) can NEVER remove it — free/trial
 * senders are the growth loop. Only paid plans whose catalog flag is set may
 * toggle it off. Single source of truth; never inline the plan check.
 */
export const canRemoveEmailBranding = (plan: PlanId | null): boolean =>
	plan !== null && PLANS[plan].emailBrandingRemovable;

/**
 * Index from Polar product id → { plan, interval }. Built lazily from the
 * resolved (env-aware) ids so a subscription's `productId` can be mapped to a
 * plan. Re-reads env on each call so test/process env changes are honoured.
 */
export const planByProductId = (
	read: (key: string) => string | undefined = (k) => process.env[k]
): Map<string, { plan: Plan; interval: BillingInterval }> => {
	const index = new Map<string, { plan: Plan; interval: BillingInterval }>();
	for (const plan of ALL_PLANS) {
		for (const [interval, binding] of Object.entries(plan.bindings)) {
			index.set(resolveProductId(binding, read), {
				plan,
				interval: interval as BillingInterval,
			});
		}
	}
	return index;
};

/**
 * A minimal, transport-agnostic view of a Polar subscription. Mirrors the
 * fields the billing router already reads off the Polar SDK object; kept loose
 * so callers don't need the full SDK type.
 */
export interface SubscriptionView {
	/**
	 * The plan version stamped into SERVER-SET checkout metadata at purchase
	 * (`planVersion`). Absent on every subscription created before versioning
	 * existed, which {@link planVersionFor} resolves to v1 — the correct answer
	 * for them, since they are the oldest customers on the oldest prices.
	 */
	readonly planVersion?: number | string | null;
	/** The Polar product id the subscription is for. */
	readonly productId?: string | null;
	readonly quantity?: number | null;
	/** Seat count for per-seat (Teams/Business) subscriptions, when present. */
	readonly seats?: number | null;
	/** Polar status, e.g. "active" | "trialing" | "canceled". */
	readonly status?: string | null;
}

/**
 * A minimal view of a desktop license entitlement (the Polar license-key
 * benefit). `active` is the resolved validity (not expired / not revoked).
 */
export interface LicenseView {
	readonly active?: boolean | null;
	readonly productId?: string | null;
}

/** What a user is entitled to, resolved from their subscription + license. */
export interface Entitlement {
	readonly desktopAccess: boolean;
	readonly managedInference: boolean;
	/** Whether the resolved plan unlocks supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/** Total included credit pool after the plan's fixed/per-seat model is applied. */
	readonly monthlyCreditPoolMicroUsd: number;
	/** The effective plan, or null when un-entitled (free baseline). */
	readonly plan: PlanId | null;
	/** Effective seat count (1 for single plans). */
	readonly seats: number;
}

/**
 * Number of external channel users an entitlement may configure for hosted bots.
 * Only managed-inference plans may use hosted bots. Personal managed plans
 * resolve to one seat; Teams and Business resolve to the billed seat count.
 * A Major Pass has Marketplace access only and therefore has no allowance.
 */
export const channelUserLimitForEntitlement = (
	entitlement: Entitlement
): number =>
	entitlement.managedInference && entitlement.plan ? entitlement.seats : 0;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const isActiveSubscription = (sub: SubscriptionView): boolean =>
	ACTIVE_SUBSCRIPTION_STATUSES.has((sub.status ?? "").toLowerCase());

const seatsFor = (plan: Plan, sub: SubscriptionView): number => {
	if (plan.seatModel.kind === "single") {
		return 1;
	}
	const requested = sub.seats ?? sub.quantity ?? plan.seatModel.minSeats;
	return Math.max(requested, plan.seatModel.minSeats);
};

const ENTITLEMENT_NONE: Entitlement = {
	plan: null,
	desktopAccess: false,
	marketplaceApps: false,
	managedInference: false,
	monthlyCreditPoolMicroUsd: 0,
	seats: 0,
};

/**
 * Resolve a user's entitlement from their active Polar subscription and/or a
 * desktop license. An active subscription (including the apps-only A Major Pass)
 * takes precedence over a license; managed plans additionally grant inference,
 * while A Major Pass grants Marketplace access only. A desktop license alone
 * grants desktop access with no credit pool. Returns the un-entitled baseline
 * when neither is present/active.
 *
 * Pure and env-injectable: pass `read` to map product ids without touching
 * `process.env` (used by the tests).
 */
export const resolveEntitlement = (
	subscription: SubscriptionView | null | undefined,
	license: LicenseView | null | undefined,
	read: (key: string) => string | undefined = (k) => process.env[k]
): Entitlement => {
	const index = planByProductId(read);

	// 1) An active subscription wins (A Major Pass or a managed plan).
	if (subscription?.productId && isActiveSubscription(subscription)) {
		const match = index.get(subscription.productId);
		if (match) {
			const { plan } = match;
			const seats = seatsFor(plan, subscription);
			// The POOL comes from the subscription's version, never from the live
			// catalog — that is what makes a future pool increase unable to reach a
			// customer still paying an older price.
			const versioned = planVersionFor(plan.id, subscription.planVersion);
			const pool = monthlyCreditPoolMicroUsdForSeats({
				plan,
				seats,
				version: versioned,
			});
			return {
				plan: plan.id,
				desktopAccess: plan.desktopAccess,
				marketplaceApps: plan.marketplaceApps,
				managedInference: plan.managedInference,
				monthlyCreditPoolMicroUsd: pool,
				seats,
			};
		}
	}

	// 2) Fall back to a desktop license (one-time purchase, no managed pool).
	if (license?.active) {
		const desktop = PLANS["desktop-license"];
		return {
			plan: desktop.id,
			desktopAccess: desktop.desktopAccess,
			marketplaceApps: desktop.marketplaceApps,
			managedInference: desktop.managedInference,
			monthlyCreditPoolMicroUsd: desktop.monthlyCreditPoolMicroUsd,
			seats: 1,
		};
	}

	// 3) No entitlement.
	return ENTITLEMENT_NONE;
};

/**
 * Whether managed inference is AVAILABLE to spend right now — a BALANCE gate, not
 * a pure tier gate. It is available when the holder has desktop-app access AND
 * either an included credit pool (a subscription's `managedInference`) OR a
 * positive PAYG wallet balance.
 *
 * This is what opens PAYG to Lifetime (`desktop-license`): that plan keeps
 * `managedInference:false` (no included pool) yet still qualifies here whenever
 * `balanceMicroUsd > 0`. The apps-only A Major Pass has no desktop access and
 * cannot use managed inference; the free (no-access) baseline never can. Single
 * source of truth for "can this user use managed inference" — never inline the
 * sub-tier check at a call-site.
 */
export const managedInferenceAvailable = (
	entitlement: Entitlement,
	balanceMicroUsd: number
): boolean =>
	entitlement.desktopAccess &&
	(entitlement.managedInference || balanceMicroUsd > 0);

/* -------------------------------------------------------------------------- *
 * Desktop trial + paywall gate (epic #496, Unit C1).
 *
 * The desktop is a PAID product ($200 list / $129 launch one-time license or a
 * Pro/Max/Teams/Business subscription),
 * but Ryu is open-core: BASIC local/free chat must stay usable forever. So the
 * gate covers only Pro features + managed inference; it never blocks the app
 * shell. A fresh install gets a 7-day trial of full access; after expiry, with
 * no active sub and no valid license key, the Pro-feature set is locked behind
 * a (dismissible) paywall, dropping the user into free local chat.
 *
 * NOTHING HARDCODED: the trial length, the offline-grace window, and the gated
 * feature set live ONLY here, as one config, never inlined across components.
 * -------------------------------------------------------------------------- */

/** One day in milliseconds; the unit the trial/grace windows are measured in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The desktop gate's tunable windows. Defaults match the epic #496 pricing
 * decisions (7-day trial). The offline-grace window is how long a cached
 * last-good entitlement is honoured when the control plane is unreachable, so a
 * paying user is NOT falsely locked out by a flaky network.
 */
export interface DesktopGateConfig {
	/**
	 * OFF-BY-DEFAULT escape hatch: while true, the gate grants Pro features to
	 * every user (no trial clock, no paywall). This is NOT the shipped model —
	 * "free Pro forever" is wrong; the correct model is open-core (the desktop
	 * shell + local/BYOK chat are ALWAYS free — the paywall is dismissible into
	 * free local chat) PLUS a 7-day full trial of Pro that then upsells. So the
	 * default is `false`: new installs get the 7-day trial, then the paywall.
	 * Keep this flag only as a break-glass to re-open everything (e.g. an
	 * incident); flipping it ships as a normal release, delivered through the
	 * user-controlled auto-updater.
	 * It always withholds managed inference (real cloud spend) and never
	 * overrides a real paying subscription/license.
	 */
	readonly betaFree: boolean;
	/** How long a cached entitlement is trusted while offline, in days. */
	readonly offlineGraceDays: number;
	/** Free-trial length from first launch, in days. */
	readonly trialDays: number;
}

/**
 * What the free trial is a trial OF — and it is NOT Pro.
 *
 * The trial branch of {@link decideDesktopAccess} returns
 * `proUnlocked: true, managedInference: false`. That is Band 2 and only Band 2:
 * the local power features a one-time **Lifetime Desktop license** unlocks
 * forever. It grants no managed inference, no credits and no cloud node — every
 * one of which is Band 3 and belongs to a Pro/Max SUBSCRIPTION.
 *
 * Calling it a "Pro trial" therefore oversold it in both directions: it promised
 * credits and a server the trial never grants, and it hid that what the user is
 * actually sampling is the Lifetime Desktop product. A trialist who then bought
 * Pro expecting the same thing plus a bill is a support ticket; one who assumed
 * the trial included managed inference is a refund.
 *
 * Single source of truth so the name cannot drift across the desktop, the web
 * pricing page and the docs the way "Pro trial" did.
 */
export const DESKTOP_TRIAL_LABEL = "Lifetime Desktop trial";

/**
 * One line for "what does the trial actually include", for any surface that
 * needs to say so. Names the exclusions explicitly, because the exclusions are
 * the part that was previously misrepresented.
 */
export const DESKTOP_TRIAL_INCLUDES =
	"Full desktop app access. Managed inference, credits and cloud nodes are not included.";

/** The single default gate config (swappable; never inlined per-component). */
export const DESKTOP_GATE: DesktopGateConfig = {
	// Open-core + a 7-day LIFETIME DESKTOP trial → upsell is the shipped model
	// (see `DESKTOP_TRIAL_LABEL` for why it is not a "Pro" trial). `betaFree` is a
	// break-glass escape hatch only (see the field doc); the default is OFF so a
	// fresh install gets the trial, then the paywall — not free Pro forever.
	betaFree: false,
	trialDays: 7,
	offlineGraceDays: 7,
};

/**
 * The paywall is SOFT and THREE-BANDED. Free (Band 1) local features — local/
 * BYOK chat, starter agents, tool calling / MCP / skills, basic run-while-open
 * workflows, Ghost/Shadow/memory/RAG — are NOT gated at all and are absent from
 * this map by construction. Numeric starter caps are a separate managed-path
 * concern. Only the two paid capability bands appear here:
 *
 *  - `"pro"`  (Band 2) — local power features that cost Ryu NOTHING to run, so a
 *    one-time Lifetime license unlocks them forever (as does any subscription,
 *    or the trial). Gated on the verdict's `proUnlocked`.
 *  - `"subscription"` (Band 3) — features that cost Ryu money EVERY MONTH (its
 *    API keys, its always-on servers, its seats). A one-time license can never
 *    unlock these; they need an ACTIVE recurring plan. Gated on `managedInference`.
 *
 * The one rule: runs on the user's machine at zero marginal cost → Band 1/2;
 * Ryu pays a recurring bill for it → Band 3.
 */
export type CapabilityTier = "pro" | "subscription";

/** Each gated capability and the entitlement tier it requires. */
export const CAPABILITY_TIERS = {
	// Band 2 — local power features; a one-time Lifetime license unlocks forever.
	"gateway-governance-ui": "pro",
	"prompt-studio": "pro",
	// Band 2 (added 2026-07-11) — power features that still run at zero marginal
	// cost to Ryu, so a one-time Lifetime license unlocks them. Fine-tune and
	// other Marketplace app/plugin surfaces are intentionally absent: their
	// catalog price is commerce metadata, not a runtime access gate.
	evals: "pro",
	graphrag: "pro",
	"companion-overlay": "pro",
	// Band 3 — Ryu pays a recurring bill; an ACTIVE subscription only.
	"managed-inference": "subscription",
	"cloud-sync": "subscription",
	"cloud-node": "subscription",
	"hosted-bots": "subscription",
	"team-seats": "subscription",
	"agent-mail": "subscription",
} as const satisfies Record<string, CapabilityTier>;

export type GatedCapability = keyof typeof CAPABILITY_TIERS;

/** Every gated capability (Band 1 free features are absent by construction). */
export const GATED_CAPABILITIES = Object.keys(
	CAPABILITY_TIERS
) as GatedCapability[];

/** The entitlement tier a capability requires. */
export const capabilityTier = (cap: GatedCapability): CapabilityTier =>
	CAPABILITY_TIERS[cap];

/** Why access is currently granted (or why it is not). */
export type AccessReason =
	| "subscription" // an active Pro/Max/Teams/Business subscription
	| "license" // a valid desktop license key
	| "beta" // free-during-beta flag is on (no trial clock, no paywall)
	| "trial" // still inside the 7-day trial window
	| "offline-grace" // live check failed; riding a cached last-good entitlement
	| "trial-expired" // trial over, no sub/license, online (locked)
	| "locked"; // no entitlement and grace exhausted (locked)

/**
 * A cached last-good entitlement, persisted locally so a paying user is not
 * locked out when the control plane is briefly unreachable. `proUnlocked` is
 * the resolved Pro state at the time it was cached; `cachedAtMs` anchors the
 * offline-grace window.
 */
export interface CachedEntitlement {
	readonly cachedAtMs: number;
	readonly managedInference: boolean;
	/** Whether the cached recurring entitlement included Marketplace apps. */
	readonly marketplaceApps: boolean;
	readonly plan: PlanId | null;
	readonly proUnlocked: boolean;
}

/** Inputs to the pure desktop-access decision. All times are epoch ms. */
export interface DesktopGateInput {
	/** Last-good cached entitlement, or null when none has ever been cached. */
	readonly cached?: CachedEntitlement | null;
	/** First-launch timestamp (server-authoritative when available). */
	readonly firstLaunchMs: number | null;
	/**
	 * Whether a desktop license key validated as active on this device. Resolved
	 * by the client from the validate endpoint; folded into the verdict here so
	 * the decision stays in one pure place.
	 */
	readonly licenseActive: boolean;
	/**
	 * The freshly-fetched entitlement, or null when the live check FAILED
	 * (offline / server error). A successful check that returns the un-entitled
	 * baseline is a non-null Entitlement with `plan: null`.
	 */
	readonly liveEntitlement: Entitlement | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
}

/** The resolved desktop-access verdict. */
export interface DesktopGateVerdict {
	/** Days remaining in the trial (0 once expired); for the countdown UI. */
	readonly daysLeftInTrial: number;
	/** True when managed inference is available (sub with the pool, not trial). */
	readonly managedInference: boolean;
	/** Whether the resolved state can use supported paid Marketplace apps. */
	readonly marketplaceApps: boolean;
	/**
	 * True when the user is on the FREE band only (no Lifetime license, no active
	 * subscription, trial expired). Under the soft paywall this NEVER blanks the
	 * app shell — it drives the dismissible upsell modal and pauses always-on
	 * background automation (a Band-2 feature). Band 1 local chat stays usable.
	 */
	readonly paywalled: boolean;
	/** The effective plan id, or null. */
	readonly plan: PlanId | null;
	/** True when Pro features are unlocked (sub / license / trial / grace). */
	readonly proUnlocked: boolean;
	readonly reason: AccessReason;
}

const daysLeft = (firstLaunchMs: number, nowMs: number, trialDays: number) => {
	const elapsedMs = nowMs - firstLaunchMs;
	const remainingMs = trialDays * MS_PER_DAY - elapsedMs;
	if (remainingMs <= 0) {
		return 0;
	}
	return Math.ceil(remainingMs / MS_PER_DAY);
};

// A null first-launch (server unreachable / never anchored) is treated as a
// FRESH trial, never an expired one — so a new or offline install is granted
// the trial rather than falsely locked out before its anchor is known.
const inTrial = (firstLaunchMs: number | null, nowMs: number, days: number) =>
	firstLaunchMs === null || nowMs - firstLaunchMs < days * MS_PER_DAY;

const cacheIsFresh = (cached: CachedEntitlement, nowMs: number, days: number) =>
	nowMs - cached.cachedAtMs < days * MS_PER_DAY;

/**
 * Decide desktop access from first-launch, the live entitlement, a license
 * check, and a cached last-good entitlement. Pure and deterministic (inject
 * `nowMs`): the sole unit-test surface and the only verification available
 * without a Tauri runtime.
 *
 * Precedence:
 *  1. Active subscription (live)        → Pro unlocked, managed-inference per plan.
 *  2. Valid desktop license (live)      → Pro unlocked, no managed inference.
 *  3. Free-during-beta flag on          → Pro unlocked (beta), no managed pool.
 *  4. Inside the 7-day trial            → Pro unlocked (trial), no managed pool.
 *  5. Live check FAILED + fresh cache   → ride the cached last-good entitlement
 *                                         (offline grace) so no false lockout.
 *  6. Otherwise                         → locked (paywall); free local chat stays.
 *
 * Note open-core: a locked verdict NEVER blocks the app shell — the caller gates
 * only {@link GATED_CAPABILITIES}, and the paywall is dismissible into free chat.
 */
export const decideDesktopAccess = (
	input: DesktopGateInput,
	config: DesktopGateConfig = DESKTOP_GATE
): DesktopGateVerdict => {
	const { liveEntitlement, licenseActive, firstLaunchMs, cached, nowMs } =
		input;
	const trialDaysLeft = firstLaunchMs
		? daysLeft(firstLaunchMs, nowMs, config.trialDays)
		: config.trialDays;

	// 1) A successful live check with an entitling subscription/license.
	if (liveEntitlement?.desktopAccess) {
		const reason: AccessReason =
			liveEntitlement.plan === "desktop-license" ? "license" : "subscription";
		return {
			proUnlocked: true,
			marketplaceApps: liveEntitlement.marketplaceApps,
			managedInference: liveEntitlement.managedInference,
			plan: liveEntitlement.plan,
			paywalled: false,
			reason,
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 2) A validated desktop license key (the live entitlement may lag the
	//    just-entered key; the explicit license flag wins).
	if (licenseActive) {
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: "desktop-license",
			paywalled: false,
			reason: "license",
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 3) Free-during-beta flag: with no real subscription/license (those win
	//    above, keeping a paying user's managed inference), grant Pro features to
	//    everyone — no trial clock, no paywall. Managed inference stays withheld
	//    (it bills real cloud spend); flip `betaFree` off to enable the paid gate.
	if (config.betaFree) {
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: null,
			paywalled: false,
			reason: "beta",
			daysLeftInTrial: 0,
		};
	}

	// 4) Inside the trial window.
	if (inTrial(firstLaunchMs, nowMs, config.trialDays)) {
		return {
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: null,
			paywalled: false,
			reason: "trial",
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 5) Live check failed (offline) but we have a fresh, Pro last-good cache:
	//    ride the grace window rather than falsely locking a paying user out.
	if (
		liveEntitlement === null &&
		cached?.proUnlocked &&
		cacheIsFresh(cached, nowMs, config.offlineGraceDays)
	) {
		return {
			proUnlocked: true,
			marketplaceApps: cached.marketplaceApps,
			managedInference: cached.managedInference,
			plan: cached.plan,
			paywalled: false,
			reason: "offline-grace",
			daysLeftInTrial: trialDaysLeft,
		};
	}

	// 6) Locked. Free local chat stays usable; the paywall gates Pro features.
	return {
		proUnlocked: false,
		marketplaceApps: false,
		managedInference: false,
		plan: null,
		paywalled: true,
		reason:
			firstLaunchMs !== null && nowMs - firstLaunchMs >= 0
				? "trial-expired"
				: "locked",
		daysLeftInTrial: 0,
	};
};

/* -------------------------------------------------------------------------- *
 * Agent Inbox lifecycle (subscription lapse → grace → deactivated → deletable).
 *
 * Agent Inboxes (Ryu Mail) are a hosted feature: the free baseline gets a small
 * allowance, while an active Pro/Max/Teams/Business plan carries the larger
 * `emailEnabled` quota. When hosted mail entitlement LAPSES an inbox must not
 * simply vanish (its address is a real, published identity and its stored mail
 * is the user's data), nor keep costing Ryu SES/storage forever. This is the one
 * place the lapse policy lives; it is a PURE, deterministic function (inject
 * `nowMs`) mirroring {@link decideDesktopAccess} — the only verification surface
 * without a live SES/Polar runtime.
 *
 * The states, in order:
 *  - `active`      — the owner's plan includes email. Inbound accepted; agent has
 *                    full access. Any prior lapse anchors are CLEARED, so a
 *                    re-upgrade within retention restores the inbox in full (the
 *                    row was never deleted; restore == reactivate, never recreate).
 *  - `grace`       — plan lapsed < `graceDays` ago. Inbound STILL accepted + stored
 *                    (never lose already-sent mail), but agent access is paused /
 *                    read-only. A clear, recoverable state.
 *  - `deactivated` — grace expired. Inbound is REJECTED (dropped-and-retained here;
 *                    a true SMTP bounce is an SES receipt-rule reject — owner-side
 *                    config). Stored mail is RETAINED for `retentionDays`, then
 *                    eligible for hard deletion (a scheduled sweep — follow-up).
 *                    The address is RESERVED: the inbox row is not deleted, so the
 *                    unique-address index blocks reassignment to any other account
 *                    (address reuse would leak the prior owner's mail).
 * -------------------------------------------------------------------------- */

/** The lapse policy's tunable windows (swappable; never inlined per-call-site). */
export interface InboxLifecycleConfig {
	/** Days after a plan lapse before an inbox is deactivated (agent read-only). */
	readonly graceDays: number;
	/** Days a deactivated inbox's stored mail is retained before deletion is eligible. */
	readonly retentionDays: number;
}

/** The single default lapse policy: 30-day grace, then 90-day retention. */
export const MAIL_LIFECYCLE: InboxLifecycleConfig = {
	graceDays: 30,
	retentionDays: 90,
};

/** An inbox's lifecycle state, derived from the owner's live entitlement + anchors. */
export type InboxLifecycleState = "active" | "grace" | "deactivated";

/** Inputs to the pure inbox-lifecycle decision. All times are epoch ms. */
export interface InboxLifecycleInput {
	/** When the inbox was deactivated (retention anchor), or null. */
	readonly deactivatedAtMs: number | null;
	/**
	 * Whether the inbox OWNER's current plan includes Agent Inboxes
	 * ({@link emailQuotaForPlan}`(plan).enabled`). This is the lapse signal.
	 */
	readonly emailEntitled: boolean;
	/** When the lapse was first observed (grace anchor), or null if never lapsed. */
	readonly lapsedAtMs: number | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
}

/** The resolved inbox-lifecycle verdict. */
export interface InboxLifecycleVerdict {
	/** Whether inbound mail is still accepted + stored (active + grace). */
	readonly acceptsInbound: boolean;
	/** Whether agent access is paused / read-only (grace + deactivated). */
	readonly agentReadOnly: boolean;
	/** Deactivation anchor to persist (null unless deactivated). */
	readonly deactivatedAtMs: number | null;
	/** When stored mail becomes eligible for hard deletion (null unless deactivated). */
	readonly eligibleForDeletionAtMs: number | null;
	/** Grace anchor to persist (null when active). */
	readonly lapsedAtMs: number | null;
	readonly state: InboxLifecycleState;
}

/**
 * Decide an inbox's lifecycle state from the owner's entitlement and the stored
 * lapse/deactivation anchors. Pure and deterministic (inject `nowMs`). The caller
 * persists the returned anchors back to the inbox when they differ from what was
 * stored (a lazy state machine — transitions are realized on next access/inbound,
 * with a scheduled sweep as the follow-up for hard deletion).
 */
export const resolveInboxLifecycle = (
	input: InboxLifecycleInput,
	config: InboxLifecycleConfig = MAIL_LIFECYCLE
): InboxLifecycleVerdict => {
	const { emailEntitled, nowMs } = input;

	// Entitled → active. Clearing the anchors is what makes a re-upgrade within
	// retention a full, automatic restore (address + stored mail): the row was
	// never deleted, so reactivation just flips the state back.
	if (emailEntitled) {
		return {
			state: "active",
			lapsedAtMs: null,
			deactivatedAtMs: null,
			acceptsInbound: true,
			agentReadOnly: false,
			eligibleForDeletionAtMs: null,
		};
	}

	// Lapsed: anchor the grace window at first observation (or reuse the stored one).
	const lapsedAtMs = input.lapsedAtMs ?? nowMs;
	const graceEndsMs = lapsedAtMs + config.graceDays * MS_PER_DAY;

	// Still within grace: inbound accepted + stored, agent access read-only.
	if (nowMs < graceEndsMs) {
		return {
			state: "grace",
			lapsedAtMs,
			deactivatedAtMs: null,
			acceptsInbound: true,
			agentReadOnly: true,
			eligibleForDeletionAtMs: null,
		};
	}

	// Deactivated: inbound rejected, stored mail retained. Anchor deactivation at
	// grace end (or reuse the stored one) so the retention window is stable.
	const deactivatedAtMs = input.deactivatedAtMs ?? graceEndsMs;
	return {
		state: "deactivated",
		lapsedAtMs,
		deactivatedAtMs,
		acceptsInbound: false,
		agentReadOnly: true,
		eligibleForDeletionAtMs:
			deactivatedAtMs + config.retentionDays * MS_PER_DAY,
	};
};

/* -------------------------------------------------------------------------- *
 * Lifetime updates window (which BUILDS a desktop-license owner is offered).
 *
 * A desktop licence is PERPETUAL. Buying it grants the app forever; what a
 * purchase buys a YEAR of is UPDATES — the JetBrains / Sublime model. So this
 * window governs exactly one thing: which releases are OFFERED and INSTALLED.
 * It never revokes access, never flips an entitlement, and deliberately does not
 * appear anywhere in {@link decideDesktopAccess}, {@link DesktopGateVerdict} or
 * {@link CachedEntitlement}. A lapsed owner keeps every feature they have; they
 * simply stop being handed builds published after their window closed.
 *
 * Be as candid about the posture as the {@link CAPABILITY_TIERS} doc above is:
 * enforcement is ADVISORY. The desktop asks Core to withhold newer releases, but
 * Core's update endpoint is unauthenticated, the cutoff lives in the user's own
 * storage, and the installers sit on a public GitHub release page. This is an
 * honour system, not a gate — it can decline to OFFER a build, it cannot prevent
 * one. Anything stronger would mean DRM on a perpetual licence.
 *
 * Both the control plane (which mints the window from Polar orders) and the
 * desktop (which compares a release against it) call THESE functions, so the
 * arithmetic, the grace and the "who does this apply to" rule exist once.
 * -------------------------------------------------------------------------- */

/** The updates window's tunables (swappable; never inlined per-call-site). */
export interface UpdatesWindowConfig {
	/**
	 * Slack added to the window end IN THE OWNER'S FAVOUR before any release is
	 * compared against it. Absorbs clock skew between GitHub, the control plane
	 * and the user's machine, so a release cut hours before the window closed is
	 * never withheld on a rounding argument. Applied EXACTLY ONCE, by
	 * {@link updatesCutoffMs} — never again downstream.
	 */
	readonly skewGraceMs: number;
	/** Years of updates one lifetime purchase adds. */
	readonly yearsPerPurchase: number;
}

/** The single default updates-window policy: one year per purchase, a day of slack. */
export const UPDATES_WINDOW: UpdatesWindowConfig = {
	skewGraceMs: MS_PER_DAY,
	yearsPerPurchase: 1,
};

// Calendar-year arithmetic in UTC. UTC (not the local-time setFullYear) so the
// result is the same instant on every machine and in CI regardless of the host
// timezone, and so it round-trips cleanly through the RFC-3339 string the
// control plane sends. Overflow normalisation is deliberate: 29 February + 1
// year has no 29 February to land on, so it rolls to 1 March — later, which is
// the direction that favours the owner.
const addYears = (ms: number, years: number): number => {
	const at = new Date(ms);
	at.setUTCFullYear(at.getUTCFullYear() + years);
	return at.getTime();
};

// A year count that can safely be handed to `addYears`: whole, non-negative, and
// never NaN/Infinity (which would produce an Invalid Date and, downstream, a
// throwing `toISOString()`).
const wholeYears = (years: number): number =>
	Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;

/**
 * End of the updates window for a set of lifetime purchases, or null when there
 * are none.
 *
 * Purchases STACK rather than re-anchor: each order adds `yearsPerPurchase` from
 * whichever is later — the moment of that purchase, or the end of the window it
 * already had. Buying again with six months left therefore yields eighteen
 * months, not twelve. (This is a deliberate change from the previous re-anchor
 * behaviour; the pricing FAQ and the in-app "Extend — buy lifetime again" CTA
 * both already promised it.)
 *
 * Calendar-year arithmetic, not 365 days, so the date the UI shows lands on the
 * purchase anniversary. A 29 February purchase rolls forward to 1 March, which
 * is the direction that favours the owner.
 *
 * Returns null — the documented "no window", which every caller treats as
 * unrestricted — rather than a non-finite number, so a malformed order or bonus
 * count can never become a NaN date downstream.
 */
export const updatesWindowEndMs = (
	orderTimesMs: readonly number[],
	bonusYears = 0,
	config: UpdatesWindowConfig = UPDATES_WINDOW
): number | null => {
	const ordered = orderTimesMs
		.filter((ms) => Number.isFinite(ms))
		.sort((a, b) => a - b);
	if (ordered.length === 0) {
		return null;
	}

	const perPurchase = wholeYears(config.yearsPerPurchase);
	let end = Number.NEGATIVE_INFINITY;
	for (const orderMs of ordered) {
		// Stack: extend the window the owner already had, unless it lapsed before
		// this purchase, in which case the purchase itself is the new anchor.
		end = addYears(Math.max(orderMs, end), perPurchase);
	}

	end = addYears(end, wholeYears(bonusYears));
	return Number.isFinite(end) ? end : null;
};

/**
 * The instant a release must be published at or before to be eligible: the
 * window end plus the skew grace. This is the ONLY place the grace is added.
 */
export const updatesCutoffMs = (
	windowEndMs: number,
	config: UpdatesWindowConfig = UPDATES_WINDOW
): number => windowEndMs + config.skewGraceMs;

/**
 * Whether the lifetime updates window governs this plan at all.
 *
 * Only a desktop-license holder with NO active recurring plan. A lifetime owner
 * who later subscribes to Pro/Max/Teams/Business resolves to that plan
 * ({@link resolveEntitlement} gives a subscription precedence over a license),
 * and an actively-paying subscriber must never be pinned to old builds or
 * upsold a licence they already have.
 */
export const updatesWindowApplies = (plan: PlanId | null): boolean =>
	plan === "desktop-license";

/** Why a release is (or is not) offered to this owner. */
export type UpdatesEligibilityReason =
	| "no-window"
	| "outside-window"
	| "unknown-release-date"
	| "within-window";

/** Inputs to the pure release-eligibility decision. All times are epoch ms. */
export interface UpdatesEligibilityInput {
	/**
	 * The GRACE-INCLUSIVE cutoff from {@link updatesCutoffMs}, or null when no
	 * window applies. Already includes the skew grace — do not add it again.
	 */
	readonly cutoffMs: number | null;
	/** Now, in epoch ms. Injected so the decision is deterministic in tests. */
	readonly nowMs: number;
	/** When the candidate release was published, or null when unknown. */
	readonly releasePublishedAtMs: number | null;
}

/** The resolved release-eligibility verdict. */
export interface UpdatesEligibilityVerdict {
	/** Whether this release may be offered and installed. */
	readonly eligible: boolean;
	readonly reason: UpdatesEligibilityReason;
	/**
	 * True when the window has already closed. Drives the renew prompt — and
	 * NOTHING else: it never revokes access.
	 */
	readonly windowLapsed: boolean;
}

/**
 * Decide whether one release may be offered to a lifetime owner. Pure and
 * deterministic (inject `nowMs`), mirroring {@link decideDesktopAccess}.
 *
 * Precedence:
 *  1. No usable cutoff              → eligible ("no-window"). FAIL OPEN.
 *  2. Otherwise note whether the window has lapsed; every verdict carries it.
 *  3. Unknown publish date          → eligible ("unknown-release-date"). FAIL OPEN.
 *  4. Published at or before cutoff → eligible ("within-window"), else withheld.
 *
 * Both fail-open branches are load-bearing: a missing window or one malformed
 * release must never stop an owner updating. The boundary at (4) is inclusive
 * and the lapse test at (2) is strict, both in the owner's favour.
 */
export const decideUpdateEligibility = (
	input: UpdatesEligibilityInput
): UpdatesEligibilityVerdict => {
	const { cutoffMs, nowMs, releasePublishedAtMs } = input;

	// 1) No window (or an unparseable one) governs this user at all.
	if (cutoffMs === null || !Number.isFinite(cutoffMs)) {
		return { eligible: true, reason: "no-window", windowLapsed: false };
	}

	// 2) Computed once so the prompt state is consistent across every branch.
	const windowLapsed = nowMs > cutoffMs;

	// 3) A release whose publish date we could not read is never withheld.
	if (releasePublishedAtMs === null || !Number.isFinite(releasePublishedAtMs)) {
		return { eligible: true, reason: "unknown-release-date", windowLapsed };
	}

	// 4) The actual comparison the whole window exists for.
	const eligible = releasePublishedAtMs <= cutoffMs;
	return {
		eligible,
		reason: eligible ? "within-window" : "outside-window",
		windowLapsed,
	};
};
