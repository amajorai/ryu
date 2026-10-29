import {
	ladderDisclosure,
	TOOL_SPEND_LADDER_VERSION,
	type ToolSpendLadder,
	toolSpendLadderSchema,
} from "@ryuhq/protocol/tool-spend-ladder";
import { z } from "zod";
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
 * fee) are enforced from here. Marketing copy keeps presentational mirrors so
 * this catalog never ships to a browser bundle: `@ryu/blocks/web/pricing.tsx`
 * (plan list prices) and `PUBLISHED_PRICING` in
 * `@ryu/blocks/web/data/standalone-pricing.ts` (deposit fees and hosted-mail
 * allowances, which `standalone-pricing.test.ts` checks against this file).
 * To swap a plan's pricing you change its row here and update those mirrors in
 * the same commit; to swap a Polar product you set its env var. See `docs/polar-products.md` for the products/prices/benefits that
 * must be created in Polar and which env vars carry their ids.
 *
 * Pricing decisions (defaults, unified organization catalog, 2026-08-19):
 *  - Desktop license  one-time $200 list (launch $129 via the LIFETIME129 discount;
 *                     Polar license-key benefit, 7-day trial, 1yr updates).
 *                     Grants desktop access, NO managed inference.
 *  - A Major Pass      $20/month or $200/year for one individual user;
 *                     supported paid Marketplace access and publisher-pool funding.
 *  - Plus             private $39/mo individual Pro companion; fixed $9 pool
 *                     with the same CX23 managed capacity and lower usage.
 *  - Pro              $49/mo individual plan; shown on the public individual
 *                     shelf; fixed $14 pool. Existing $39 contracts remain
 *                     grandfathered at their recorded pricing version.
 *  - Max              $99/mo individual plan; shown on the public individual
 *                     shelf; fixed $30 pool.
 *  - Teams            $50/member seat/mo, five-seat minimum ($250 floor),
 *                     organization-owned; pooled credits grow by $50 per five
 *                     billed seats in the current pricing version.
 *  - Teams Lite       private $150/month five-seat floor ($100 below Teams),
 *                     then $50 per additional seat; pooled credits grow by $20
 *                     per five billed seats.
 *  - Business         $300/month for five seats, then $50 per seat; pooled
 *                     credits grow by $100 per completed five-seat bundle.
 *  - Hosted services  {@link SERVICE_RATES}: Box capacity, Notify events,
 *                     Passport connections and fetches, and Mail overage,
 *                     settled against the org wallet (2026-10-12).
 *  - Credits top-up   deposit fee 27% base (26.5% Plus/Pro, 26% Max/org) + $5
 *                     floor, capped so Ryu keeps at most $10 per top-up;
 *                     usage debits AT COST (markup 0). Manual presets
 *                     are $100, $250, and $1,000 face values, with custom
 *                     $5–$1,000 amounts; bundles do not discount the face.
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
	TEAMS_LITE_SEAT_PRICE_TIERS,
} from "./plan-seat-pricing.ts";
import {
	DEFAULT_VARIANT,
	type IsoDate,
	LEGACY_REGIONS,
	type PlanRegion,
	type PlanVariant,
	type PlanVariantCell,
	type PlanVariantKey,
	parseCellKey,
	variantKey,
} from "./plan-variants.ts";

// One micro-USD is a millionth of a dollar; the unit the credit wallet stores.
const MICRO_USD_PER_USD = 1_000_000;

/** Convert whole USD (may be fractional) to integer micro-USD. */
export const usdToMicro = (usd: number): number =>
	Math.round(usd * MICRO_USD_PER_USD);

/** Lifetime list and launch prices shared by checkout, Polar provisioning, and UI. */
export const LIFETIME_LIST_PRICE_USD = 200;
export const LIFETIME_LAUNCH_PRICE_USD = 129;

/**
 * Manual prepaid credit presets. These are USD face values, not discount
 * prices: the wallet receives the selected face value and the server adds the
 * applicable deposit fee to checkout. Keep the preset list shared by server,
 * Web, and Desktop so every surface quotes the same bundles.
 */
export const CREDIT_TOPUP_PACKS_USD = [100, 250, 1000] as const;
export type CreditTopupPackUsd = (typeof CREDIT_TOPUP_PACKS_USD)[number];
/** Hidden legacy ids remain accepted by the API for older clients. */
export const CREDIT_TOPUP_LEGACY_PACKS_CENTS = {
	"10": 1000,
	"25": 2500,
} as const;
export type CreditTopupPack = `${CreditTopupPackUsd}`;
export type CreditTopupLegacyPack =
	keyof typeof CREDIT_TOPUP_LEGACY_PACKS_CENTS;

const topupPackByUsd = {
	100: "100",
	250: "250",
	1000: "1000",
} satisfies Record<CreditTopupPackUsd, CreditTopupPack>;
export const CREDIT_TOPUP_PRESETS = Object.freeze(
	CREDIT_TOPUP_PACKS_USD.map((amountUsd) => ({
		amountCents: amountUsd * 100,
		label: `$${amountUsd.toLocaleString("en-US")}`,
		pack: topupPackByUsd[amountUsd],
	}))
);

export const CREDIT_TOPUP_MIN_CENTS = 500;
export const CREDIT_TOPUP_MAX_CENTS = 100_000;

/** The plan identifiers. `none` is the un-entitled free baseline. */
export const PLAN_IDS = [
	"desktop-license",
	"marketplace-membership",
	"plus",
	"pro",
	"max",
	"teams",
	"teams-lite",
	"business",
] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Organization-owned recurring plans that use human member seats. */
export const ORGANIZATION_PLAN_IDS = [
	"teams",
	"teams-lite",
	"business",
] as const;
export type OrganizationPlanId = (typeof ORGANIZATION_PLAN_IDS)[number];

const organizationPlanBoundarySchema = z.preprocess(
	(value) => value,
	z.enum(ORGANIZATION_PLAN_IDS)
);
export const isOrganizationPlanId = (
	value: z.input<typeof organizationPlanBoundarySchema>
): value is OrganizationPlanId =>
	organizationPlanBoundarySchema.safeParse(value).success;

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
	 * Max agent aliases the plan may hold on its owner's mailbox (0 when the
	 * plan adds no allowance). Pending and active aliases and legacy agent
	 * inboxes count; revoked aliases do not. Every plan that includes mail is
	 * UNLIMITED ({@link Number.POSITIVE_INFINITY}): like inboxes, the cap is on
	 * STORAGE, and aliases add no send or storage allowance of their own.
	 */
	readonly emailAliasLimit: number;
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
	 * Whether this plan adds its own Agent Inboxes allowance (Ryu Mail — the
	 * AgentMail-style email-as-a-service over AWS SES: store inboxes, receive +
	 * send email). Managed recurring plans include one. The apps-only A Major
	 * Pass and the desktop license add none, so their holders keep the free
	 * baseline ({@link emailQuotaForPlan}); buying them never removes mail.
	 */
	readonly emailEnabled: boolean;
	/**
	 * Max number of Agent Inboxes the plan may create (0 when the plan adds no
	 * allowance). Managed plans (pro/plus/max/teams/teams-lite/business) allow
	 * UNLIMITED inboxes ({@link Number.POSITIVE_INFINITY}); the cap is on
	 * STORAGE ({@link emailStorageLimitGb}), not count.
	 */
	readonly emailInboxLimit: number;
	/**
	 * Max outbound emails the plan may send per calendar month (0 when the plan
	 * adds no allowance). Each recipient address listed on a message counts as one.
	 */
	readonly emailMonthlySendLimit: number;
	/**
	 * Max total stored Agent Inbox bytes the plan may hold, expressed in whole
	 * GiB (0 when the plan adds no allowance). This — not inbox count — is what
	 * caps Agent Inboxes: plus 10, pro 10, max 100, teams 20, and business 20; the free
	 * baseline holds {@link FREE_EMAIL_STORAGE_LIMIT_GB}. Enforced by the mail
	 * router; the byte figure is derived via {@link emailStorageLimitBytes}.
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
	 * SEAT per month for per-seat plans (Teams, Teams Lite, and Business). 0 for plans with no recurring
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

/**
 * The map keyed by plan → recurring list price (micro-USD): per month for single
 * plans, per SEAT per month for Teams, Teams Lite, and Business. The one-time desktop license has no
 * recurring price (0). These are the ONLY plan-price figures in the codebase;
 * the included credit grant is DERIVED from them by
 * {@link includedCreditPoolMicroUsd}, never hand-typed per row.
 */
export const PLAN_MONTHLY_PRICE_MICRO_USD = {
	"desktop-license": 0, // one-time list price; no recurring price
	"marketplace-membership": usdToMicro(20),
	plus: usdToMicro(39),
	pro: usdToMicro(49),
	max: usdToMicro(99),
	// Per-seat list price. Five Teams seats therefore start at $250/mo.
	teams: usdToMicro(50),
	// Teams Lite charges $30 per seat for the first five seats, so its floor is $150/mo.
	"teams-lite": usdToMicro(30),
	// Business's first graduated band is $60/seat for five seats ($300/mo);
	// subsequent seats use the tiered price recorded below.
	business: usdToMicro(60),
} satisfies Record<PlanId, number>;

/* -------------------------------------------------------------------------- *
 * PLAN VERSIONS — what a subscriber bought, not what we sell today.
 * -------------------------------------------------------------------------- */

/** One historical (price, pool) pairing for a plan. Append-only. */
export interface PlanVersion {
	/** Marginal price after the version's base seat count, when graduated. */
	readonly additionalSeatPriceMicroUsd?: number;
	/** Total price at the version's minimum seat count, when graduated. */
	readonly baseMonthlyPriceMicroUsd?: number;
	/**
	 * The Polar products this row OWNS, per interval. Absent on every row up to
	 * {@link LEGACY_SHARED_PRODUCT_MAX_VERSION}: those sell on the plan-level
	 * `PLANS[plan].bindings`, shared across versions and told apart by the
	 * `planVersion` checkout stamp. Every later row must own its products, so the
	 * product id alone identifies the row (a migration changes the product, and
	 * Polar cannot re-stamp metadata). `money-path-invariants.test.ts` enforces it.
	 */
	readonly bindings?: Partial<Record<BillingInterval, PolarBinding>>;
	/** Bundle size for a bundled historical pool. */
	readonly creditPoolBundleSize?: number;
	/** Historical pool scaling, when it differs from the current plan model. */
	readonly creditPoolModel?: CreditPoolModel;
	/** Included pool per month; scaling is controlled by this row or the live plan. */
	readonly monthlyCreditPoolMicroUsd: number;
	/** List price when this version was sold, per month / per seat. */
	readonly monthlyPriceMicroUsd: number;
	/** Pricing regions this row's price applies in. Absent: every region. */
	readonly regions?: readonly PlanRegion[];
	/** Graduated seat prices for this historical/current version, when any. */
	readonly seatPriceTiers?: readonly PlanSeatPriceTier[];
	/** Release date, required for rows after the legacy shared-product max. */
	readonly shippedOn?: IsoDate;
	/**
	 * The promise this row was SOLD under. Absent means `"pinned"`: the public
	 * billing docs say existing contracted organizations keep their contracted
	 * price and pool, so every row sold so far was sold pinned, and an adverse
	 * migration of it needs an explicit, reviewed override in
	 * `plan-grandfathering.ts`. `"notice_may_change"` is only valid for rows
	 * shipped on or after {@link GRANDFATHER_PROMISE_CHANGED_ON}.
	 */
	readonly soldUnder?: ContractPromise;
	/** What the row is sold on. Absent: {@link DEFAULT_VARIANT}. */
	readonly variant?: PlanVariant;
	/** Monotonic; 1 is the original. */
	readonly version: number;
}

/** The price promise a row was sold under. See {@link PlanVersion.soldUnder}. */
export type ContractPromise = "pinned" | "notice_may_change";

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
 * losing money. To change pricing, push a new row that OWNS its Polar products
 * (`bindings`), point {@link CURRENT_PLAN_ROWS} at it, and declare every
 * superseded row's fate in `GRANDFATHERING_DECISIONS` (`plan-grandfathering.ts`):
 * kept forever, kept until a date, or moved at a renewal with at least 30 days'
 * notice. Moves are run by the migration job only after an admin arms them;
 * never `--reprice` a Polar product that still has subscribers. See
 * `docs/pricing-versioning.md`.
 *
 * NOT YET POSSIBLE: making a row-owned row CURRENT. Checkout, plan change and
 * the org-subscription lookup (`billing.ts`) still sell and recognise the
 * plan-level `PLANS[plan].bindings` and stamp the current version, so a
 * current row above {@link LEGACY_SHARED_PRODUCT_MAX_VERSION} would be sold
 * the shared product with a stamp none of its rows has and resolve to the
 * OLDEST row. Route those through `bindingFor(plan, currentRowFor(...))` and
 * {@link planProductIndex} first; `money-path-invariants.test.ts` ("resolves
 * the product checkout sells to the current row") fails until then.
 *
 * NODE TYPE IS DELIBERATELY NOT VERSIONED (the node profile is per variant,
 * not per row). `BASE_NODE_TYPE_BY_PLAN` is keyed by
 * plan: a NEW server for any subscriber gets today's base server, while a
 * server that already exists keeps the size it was created with (never resized
 * by a renewal, seat change or upgrade; see `base-node.ts`). The margin model
 * in `plan-economics.test.ts` charges every version the current node cost and
 * separately checks the grandfathered legacy sizes.
 */
/** Every supported plan has at least one historical commercial version. */
export type PlanVersionCatalog = {
	readonly [Id in PlanId]: readonly [PlanVersion, ...PlanVersion[]];
};
export const PLAN_VERSIONS: PlanVersionCatalog = {
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
	plus: [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(10),
			creditPoolModel: "fixed",
		},
		{
			// Founder decision 2026-10-20: same $39 price, $9 pool, so the yearly
			// term clears the 20% worst-case floor with 5,000 sends and 10 GiB of
			// mail and Space storage costed. v1 subscribers keep their $10 pool.
			version: 2,
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
			creditPoolModel: "fixed",
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
		{
			// Founder decision 2026-10-20: same $49 price, $14 pool, so the yearly
			// term clears the 20% worst-case floor with 5,000 sends and 10 GiB of
			// mail and Space storage costed. v1-v6 keep their recorded pool.
			version: 7,
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(14),
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
	"teams-lite": [
		{
			version: 1,
			monthlyPriceMicroUsd: usdToMicro(30),
			monthlyCreditPoolMicroUsd: usdToMicro(20),
			creditPoolModel: "per_bundle",
			creditPoolBundleSize: 5,
			seatPriceTiers: TEAMS_LITE_SEAT_PRICE_TIERS,
			baseMonthlyPriceMicroUsd: usdToMicro(150),
			additionalSeatPriceMicroUsd: usdToMicro(50),
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
export const CURRENT_PLAN_VERSION_BY_PLAN = {
	"desktop-license": 4,
	"marketplace-membership": 6,
	plus: 2,
	pro: 7,
	max: 4,
	teams: 5,
	"teams-lite": 1,
	business: 2,
} satisfies Record<PlanId, number>;

export const currentPlanVersionFor = (plan: PlanId): number =>
	CURRENT_PLAN_VERSION_BY_PLAN[plan];

/**
 * The newest version per plan at the time row-owned products were introduced:
 * every row up to and including this one sells on the plan-level (shared)
 * `PLANS[plan].bindings`. FROZEN by `money-path-invariants.test.ts`; every row
 * after it must carry its own `bindings`. Verified against `PLAN_VERSIONS` on
 * 2026-10-21 (Plus v2 and Pro v7 are the $9 and $14 pool rows; checkout still
 * sells the shared Plus and Pro products, so they sit inside this bound; note `max` and `desktop-license` have a v5 that is not their
 * current row: both repeat v4's terms and are kept append-only).
 */
export const LEGACY_SHARED_PRODUCT_MAX_VERSION = {
	"desktop-license": 5,
	"marketplace-membership": 6,
	plus: 2,
	pro: 7,
	max: 5,
	teams: 5,
	"teams-lite": 1,
	business: 2,
} satisfies Record<PlanId, number>;

/**
 * The day the public billing docs started describing per-version
 * grandfathering policies instead of "existing customers keep their price".
 * NULL until legal sign-off ships that text (see `docs/pricing-versioning.md`);
 * while it is null no row may be sold under `"notice_may_change"`.
 */
export const GRANDFATHER_PROMISE_CHANGED_ON: IsoDate | null = null;

/**
 * The row SOLD today per plan and variant. One capacity and one provider today,
 * so this is {@link CURRENT_PLAN_VERSION_BY_PLAN} keyed by `hetzner:standard`;
 * a provider or capacity offer adds a key here, never a second current row for
 * the same key.
 */
export const CURRENT_PLAN_ROWS: {
	readonly [Id in PlanId]: Partial<Record<PlanVariantKey, number>> & {
		readonly "hetzner:standard": number;
	};
} = {
	"desktop-license": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["desktop-license"],
	},
	"marketplace-membership": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["marketplace-membership"],
	},
	plus: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.plus },
	pro: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.pro },
	max: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.max },
	teams: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.teams },
	"teams-lite": {
		"hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN["teams-lite"],
	},
	business: { "hetzner:standard": CURRENT_PLAN_VERSION_BY_PLAN.business },
};

/** The variant a row is sold on. */
export const rowVariant = (row: PlanVersion): PlanVariant =>
	row.variant ?? DEFAULT_VARIANT;

/** The pricing regions a row's price applies in. */
export const rowRegions = (row: PlanVersion): readonly PlanRegion[] =>
	row.regions ?? LEGACY_REGIONS;

/** Whether `row` is the row currently sold for its plan and variant. */
export const isCurrentRow = (plan: PlanId, row: PlanVersion): boolean => {
	const current: Partial<Record<PlanVariantKey, number>> =
		CURRENT_PLAN_ROWS[plan];
	return current[variantKey(rowVariant(row))] === row.version;
};

/** The row sold today in `cell`, or null when the plan is not sold there. */
export const currentRowFor = (
	plan: PlanId,
	cell: PlanVariantCell
): PlanVersion | null => {
	const current: Partial<Record<PlanVariantKey, number>> =
		CURRENT_PLAN_ROWS[plan];
	const version = current[variantKey(cell)];
	const row = PLAN_VERSIONS[plan].find(
		(candidate) => candidate.version === version
	);
	return row && rowRegions(row).includes(cell.region) ? row : null;
};

/** Decode a provider's legacy version marker with native Number semantics.
 * Unknown versions still fall back to the oldest row; symbols retain their
 * native conversion error. JSON arrays and booleans were accepted by this
 * lookup before provider metadata gained an explicit input contract.
 */
export const planVersionInputSchema = z
	.unknown()
	.transform((value) => Number(value));

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
	version?: z.input<typeof planVersionInputSchema>
): PlanVersion => {
	const rows = PLAN_VERSIONS[plan];
	const wanted = planVersionInputSchema.parse(version);
	if (Number.isFinite(wanted)) {
		const hit = rows.find((r) => r.version === wanted);
		if (hit) {
			return hit;
		}
	}
	return rows[0];
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
 * The free managed cloud node is included with every recurring managed plan
 * in a supported/default region: one base server, `cx23` in the EU for every
 * plan (Teams, Teams Lite and Business may get the same-price `cpx22` when
 * `cx23` is sold out). Plus, Pro and Max do not promise a free regional node in
 * Singapore because its shapes exceed their safe annual cost envelope; Teams,
 * Teams Lite, and Business use `cpx22` there. The server-side location resolver owns that exception. The node's
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
 * `constants.ts` where a matching product already exists (pro/plus/max monthly+
 * yearly, lifetime → reused as the desktop license placeholder). Business,
 * Teams, and desktop license bindings that need NEW Polar products use a
 * clearly-fake
 * placeholder default ("polar_product_<slug>") so a misconfigured deploy fails
 * loudly rather than silently charging the wrong product. See
 * `docs/polar-products.md`.
 */
/** Consumers read the same Plan contract for every billing identifier. */
type PlanCatalog = { [Id in PlanId]: Plan };
export const PLANS: PlanCatalog = {
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
		emailAliasLimit: 0,
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
		emailAliasLimit: 0,
		emailMonthlySendLimit: 0,
		emailStorageLimitGb: 0,
		emailBrandingRemovable: false,
		// A Major Pass is for one individual user. Shared Marketplace access is
		// not an organization-seat product; teams should use Teams, Teams Lite, or Business.
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
	plus: {
		audience: "individual",
		id: "plus",
		name: "Ryu Plus",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		// Private lower-usage Pro companion: $39/mo with a fixed $9 pool (v2).
		// It keeps the same individual CX23 capacity while making the reduced
		// included usage explicit in its own pricing contract.
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD.plus,
		monthlyCreditPoolMicroUsd: usdToMicro(9),
		marketplacePublisherPool: false,
		// Agent Inboxes: UNLIMITED count; 5,000 sends and 10 GiB of stored mail
		// (founder decision 2026-10-20, Pro's allowance). Over-cap paid sends
		// still flow as credit-funded overage.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailAliasLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 5000,
		emailStorageLimitGb: 10,
		emailBrandingRemovable: true,
		seatModel: { kind: "single" },
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_PLUS_MONTHLY",
				productIdDefault: "polar_product_plus_monthly",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_PLUS_YEARLY",
				productIdDefault: "polar_product_plus_yearly",
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
		monthlyCreditPoolMicroUsd: usdToMicro(14),
		marketplacePublisherPool: false,
		// Agent Inboxes: UNLIMITED count for a personal workspace; capped by 10 GiB
		// of stored mail (emailStorageLimitGb), not by inbox count. Set
		// 2026-10-20 (founder decision) from 10,000 sends / 20 GiB to 5,000 / 10.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailAliasLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 5000,
		emailStorageLimitGb: 10,
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
		// Agent Inboxes: UNLIMITED count; capped by 100 GiB of stored mail.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailAliasLimit: Number.POSITIVE_INFINITY,
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
		// Agent Inboxes: UNLIMITED count; capped by a flat org-wide 20 GiB of
		// stored mail.
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailAliasLimit: Number.POSITIVE_INFINITY,
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
	"teams-lite": {
		audience: "organization",
		id: "teams-lite",
		name: "Ryu Teams Lite",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		// Private lower-usage organization offer: $30/seat for the first five
		// seats ($150 floor), then the standard $50 marginal seat price.
		monthlyPriceMicroUsd: PLAN_MONTHLY_PRICE_MICRO_USD["teams-lite"],
		monthlyCreditPoolMicroUsd: usdToMicro(20),
		marketplacePublisherPool: false,
		seatPriceTiers: TEAMS_LITE_SEAT_PRICE_TIERS,
		baseMonthlyPriceMicroUsd: usdToMicro(150),
		additionalSeatPriceMicroUsd: usdToMicro(50),
		emailEnabled: true,
		emailInboxLimit: Number.POSITIVE_INFINITY,
		emailAliasLimit: Number.POSITIVE_INFINITY,
		emailMonthlySendLimit: 100_000,
		emailStorageLimitGb: 20,
		emailBrandingRemovable: true,
		seatModel: { kind: "per_seat", minSeats: 5 },
		creditPoolModel: "per_bundle",
		creditPoolBundleSize: 5,
		bindings: {
			monthly: {
				productIdEnv: "POLAR_PRODUCT_TEAMS_LITE_MONTHLY",
				productIdDefault: "polar_product_teams_lite_monthly",
			},
			yearly: {
				productIdEnv: "POLAR_PRODUCT_TEAMS_LITE_YEARLY",
				productIdDefault: "polar_product_teams_lite_yearly",
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
		emailAliasLimit: Number.POSITIVE_INFINITY,
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
	maxAgents: {
		free: Number.POSITIVE_INFINITY,
		label: "Agents",
		owner: null,
		unit: "count",
	},
	maxConcurrentRuns: {
		free: Number.POSITIVE_INFINITY,
		label: "Concurrent runs",
		owner: null,
		// Managed execution is protected by entitlement and credit budgets.
		unit: "count",
	},
	maxEvalRunsMonthly: {
		free: Number.POSITIVE_INFINITY,
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
	maxSpaces: {
		free: Number.POSITIVE_INFINITY,
		label: "Spaces",
		owner: null,
		unit: "count",
	},
	spaceStorageLimitGb: {
		free: 1,
		label: "Space storage",
		owner: null,
		// Real storage cost, so finite on paid rows too. EVERY plan id needs a
		// row: an absent plan resolves to Infinity in `planLimit`. A Major Pass
		// adds no hosted storage of its own, so it keeps the free baseline.
		paid: {
			"desktop-license": 20,
			"marketplace-membership": 1,
			// Set 2026-10-20 with the mail allowances (founder decision).
			pro: 10,
			plus: 10,
			max: 50,
			teams: 50,
			"teams-lite": 50,
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
export const QUOTAS = {
	...KERNEL_QUOTAS,
} satisfies Readonly<Record<PlanLimitField, QuotaSpec>>;

/** Retained for callers that render quota ownership; remaining keys are Core-owned. */
export const quotaOwner = (field: PlanLimitField): string | null =>
	QUOTAS[field].owner;

/**
 * The FREE (null-plan) baseline for every quota, projected out of {@link QUOTAS}.
 * Kept as an exported record because consumers iterate it; the numbers themselves
 * live on each {@link QuotaSpec}. Read it through {@link planLimit}, never inline.
 */
export const FREE_TIER_LIMITS: Readonly<Record<PlanLimitField, number>> =
	// SAFETY: Every QUOTAS key is projected once to its numeric free allowance.
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
	const spec: QuotaSpec = QUOTAS[field];
	if (!plan) {
		return spec.free;
	}
	return spec.paid?.[plan] ?? Number.POSITIVE_INFINITY;
};

/** Bytes in one gibibyte; the unit the storage cap is expressed against. */
const BYTES_PER_GB = 1024 ** 3;

/** Free baseline hosted-mail storage (GiB), kept small to bound inbound abuse. */
export const FREE_EMAIL_STORAGE_LIMIT_GB = 1;

/** Convert a whole-GiB storage figure to bytes (Infinity stays unbounded). */
export const gibToBytes = (gib: number): number =>
	gib === Number.POSITIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: gib * BYTES_PER_GB;

/**
 * Whether a plan's Agent Inboxes allowance is the free baseline: no plan, or a
 * plan that adds no hosted-mail allowance of its own (A Major Pass, the desktop
 * license). The free baseline is one allowance per person, not per
 * organization; the mail router meters it against the account that owns it.
 */
export const emailUsesFreeBaseline = (plan: PlanId | null): boolean =>
	plan === null || !PLANS[plan].emailEnabled;

/**
 * The total stored-mail cap (in bytes) a plan grants for Agent Inboxes, derived
 * from its {@link Plan.emailStorageLimitGb}. A plan on the free baseline
 * ({@link emailUsesFreeBaseline}) receives the free 1 GiB storage allowance.
 * An unbounded figure ({@link Number.POSITIVE_INFINITY}) maps straight to
 * Infinity (no byte multiply). Single source of truth; never inline the multiply
 * in the mail router.
 */
export const emailStorageLimitBytes = (plan: PlanId | null): number =>
	gibToBytes(
		plan === null || emailUsesFreeBaseline(plan)
			? FREE_EMAIL_STORAGE_LIMIT_GB
			: PLANS[plan].emailStorageLimitGb
	);

/** The Agent Inboxes (Ryu Mail) quota a plan grants. */
export interface EmailQuota {
	/**
	 * Max agent aliases on the owner's mailbox. Free has three; paid plans are
	 * UNLIMITED ({@link Number.POSITIVE_INFINITY}).
	 */
	readonly aliasLimit: number;
	/** Whether Agent Inboxes are available at all on this plan. */
	readonly enabled: boolean;
	/**
	 * Max inboxes the plan may hold. Free has one; paid plans are UNLIMITED
	 * ({@link Number.POSITIVE_INFINITY}); enforcement caps STORAGE, not count.
	 */
	readonly inboxLimit: number;
	/** Max outbound emails per calendar month; each listed recipient is one. */
	readonly monthlySendLimit: number;
	/**
	 * Max total stored Agent Inbox bytes the plan may hold (the real Agent Inbox
	 * cap). {@link Number.POSITIVE_INFINITY} means uncapped; all current plans are
	 * finite.
	 */
	readonly storageLimitBytes: number;
}

/**
 * The free growth-loop allowance. Fifty emails (counted per recipient) is
 * enough for a real agent to reach a small audience without turning a free
 * account into a bulk-mail account. It is intentionally branded, capped to one
 * inbox and three agent aliases, and granted once per person across every
 * organization they own; paid tiers buy materially more volume and storage.
 */
export const EMAIL_QUOTA_FREE: EmailQuota = {
	enabled: true,
	inboxLimit: 1,
	aliasLimit: 3,
	monthlySendLimit: 50,
	storageLimitBytes: emailStorageLimitBytes(null),
};

/**
 * Resolve the Agent Inboxes quota for a plan id. A plan on the free baseline
 * (no plan, A Major Pass, or the desktop license — see
 * {@link emailUsesFreeBaseline}) gets {@link EMAIL_QUOTA_FREE}: buying a
 * product that adds no mail allowance never leaves a customer with less than
 * a free account. The numbers live ONLY in the plan catalog above — never
 * inline them in the mail router or the pricing page (that page's strings are
 * marketing copy; THIS is the enforced limit).
 */
export const emailQuotaForPlan = (plan: PlanId | null): EmailQuota => {
	if (plan === null || emailUsesFreeBaseline(plan)) {
		return EMAIL_QUOTA_FREE;
	}
	const p = PLANS[plan];
	return {
		enabled: p.emailEnabled,
		inboxLimit: p.emailInboxLimit,
		aliasLimit: p.emailAliasLimit,
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
 * Whether a plan drops the "Powered by Ryu" badge Ryu stamps on the public pages
 * it serves for a member: published Sites, Forms respondent pages, public
 * feedback boards, embedded agents and the assistant widget. It is the same growth
 * loop as the email footer and the same catalog flag decides it, so a plan that
 * may unbrand its mail may unbrand its pages and no plan can do one but not the
 * other. Free, trial and one-time desktop licences stay branded.
 */
export const canRemovePoweredByRyu = (plan: PlanId | null): boolean =>
	canRemoveEmailBranding(plan);

/* -------------------------------------------------------------------------- *
 * Hosted service rates (decided 2026-10-12, `docs/service-billing.md`)
 * -------------------------------------------------------------------------- */

/** Seconds in the 30-day month that every per-month service rate is defined over. */
export const SERVICE_BILLING_MONTH_SECONDS = 30 * 24 * 60 * 60;

/**
 * One metered unit of a Ryu-hosted service: `microUsd` for every `perUnits`
 * units, after `freePerMonth` units per organization per calendar month (UTC).
 * Integer-only so a charge is exact before its single round-up.
 */
export interface ServiceMeterRate {
	readonly freePerMonth: number;
	readonly microUsd: number;
	readonly perUnits: number;
}

/** The three Box sizes, as every Box rate table names them. */
export const BOX_SIZES = ["small", "default", "large"] as const;
/** A Box size (`apps/box/src/contracts.ts` `BoxSize`). */
export type BoxRateSize = (typeof BOX_SIZES)[number];

/**
 * The customer price of a running Box per hour, by size, in micro-USD
 * (founder sign-off 2026-10-20, docs/box-per-session-desktop.md §11):
 * small $0.025, default $0.04, large $0.07.
 *
 * Every Box price reads these numbers, and each side's tests read the shared
 * fixture `crates/gateway/contracts/fixtures/box-rates.json`: the Gateway's
 * default size rates (Core-created Boxes, billed by sandbox ticks), Core's
 * credit pre-flight (through the Gateway's quote), the settlement of dashboard
 * and API Boxes, the core-tenant reconciliation, and the Box service's
 * fallback-loss revenue.
 */
export const BOX_SIZE_MICRO_USD_PER_HOUR = Object.freeze({
	small: 25_000,
	default: 40_000,
	large: 70_000,
} as const satisfies Record<BoxRateSize, number>);

/**
 * Every start of a Box (a create or a resume) is billed for at least this
 * many seconds, and each running interval is rounded up to whole
 * {@link BOX_BILLING_ROUNDING_SECONDS}.
 */
export const BOX_MINIMUM_SECONDS_PER_START = 300;
/** A Box's running interval is billed in whole minutes, rounded up. */
export const BOX_BILLING_ROUNDING_SECONDS = 60;

/**
 * Billable seconds of one running interval of `seconds`: rounded up to whole
 * minutes, and never less than the per-start minimum. A start that ran for 0
 * seconds still bills the minimum.
 */
export function boxBillableSeconds(seconds: number): number {
	const whole = Math.max(0, Math.ceil(seconds));
	const rounded =
		Math.ceil(whole / BOX_BILLING_ROUNDING_SECONDS) *
		BOX_BILLING_ROUNDING_SECONDS;
	return Math.max(BOX_MINIMUM_SECONDS_PER_START, rounded);
}

/** Box state and snapshot storage: $0.05 per GiB-month (30 days). */
export const BOX_STORAGE_MICRO_USD_PER_GIB_MONTH = 50_000;

/**
 * Box storage (saved state plus named snapshots) each organization stores
 * without charge, in GiB (docs/box-cloud-plan.md §8.2): 10 GiB without a paid
 * managed plan, 25 GiB on one. Storage above it is charged at
 * {@link BOX_STORAGE_MICRO_USD_PER_GIB_MONTH} for as long as it is stored.
 */
export const BOX_INCLUDED_STORAGE_GIB = Object.freeze({
	trial: 10,
	paid: 25,
} as const);

/**
 * The included Box storage of an org on `plan`. The plans without managed
 * capacity (the desktop license and A Major Pass), no plan, and a paid plan
 * still in its free trial get the trial allowance, as they get the trial
 * concurrency row.
 */
export function boxIncludedStorageGib(
	plan: PlanId | null,
	trialing = false
): number {
	return boxConcurrencyTier(plan, trialing) === "trial"
		? BOX_INCLUDED_STORAGE_GIB.trial
		: BOX_INCLUDED_STORAGE_GIB.paid;
}

/** How an org's Box storage (saved state and named snapshots) is sold. */
export interface BoxStoragePolicy {
	/**
	 * Whether storage above the included amount is sold, at
	 * {@link BOX_STORAGE_MICRO_USD_PER_GIB_MONTH}. False on the trial row:
	 * storage beyond the included 10 GiB is not available (the Box service
	 * refuses new Boxes, resumes and snapshots past it), so nothing above it
	 * is charged.
	 */
	beyondIncluded: boolean;
	includedGib: number;
}

/** The Box storage policy of an entitlement (docs/box-cloud-plan.md §8.2). */
export function boxStoragePolicyFor(
	entitlement: Pick<Entitlement, "plan" | "trialing">
): BoxStoragePolicy {
	const trial =
		boxConcurrencyTier(entitlement.plan, entitlement.trialing === true) ===
		"trial";
	return {
		beyondIncluded: !trial,
		includedGib: trial
			? BOX_INCLUDED_STORAGE_GIB.trial
			: BOX_INCLUDED_STORAGE_GIB.paid,
	};
}

/**
 * The shared-plan pricing ladder for tool spend (Treg parity C6, contract
 * `@ryuhq/protocol/tool-spend-ladder`): volume rungs over an organization's
 * calendar-month tool spend. Disabled with no rungs: whether Ryu offers
 * volume pricing on tool calls, at which thresholds and discounts, is a
 * pending commercial decision, and nothing here may be enabled before it is
 * recorded in `decision`. `PUBLISHED_PRICING.toolSpendLadder` must disclose
 * exactly `toolSpendLadderDisclosure()` (empty while disabled);
 * `standalone-pricing.test.ts` fails until the two agree. Settlement does not
 * read it yet: enabling it also needs a month-to-date tool spend source in
 * `service-usage-settlement.ts`.
 */
export const TOOL_SPEND_LADDER: ToolSpendLadder = toolSpendLadderSchema.parse({
	appliesTo: [],
	decision: {
		decidedOn: null,
		note: "No volume pricing for tool calls is decided; tool calls are charged at their published per-call prices.",
		status: "pending",
	},
	enabled: false,
	rungs: [],
	version: TOOL_SPEND_LADDER_VERSION,
});

/** The ladder rungs a pricing page must disclose, in published units. */
export function toolSpendLadderDisclosure(): {
	discountBps: number;
	fromUsd: number;
	label: string;
}[] {
	return ladderDisclosure(TOOL_SPEND_LADDER).map((rung) => ({
		discountBps: rung.discountBps,
		fromUsd: rung.fromMicroUsd / 1_000_000,
		label: rung.label,
	}));
}

/**
 * Fees on composed tools (Treg parity C7). A maker sets a per-run fee on a
 * composed tool in Connect; the caller pays it once per completed run
 * (ledger reason `connect_composed`) and settlement credits the maker's
 * organization with it less the platform take (`composed_tool_earnings`).
 * The platform take is 0: whether composed-tool sales carry a platform share,
 * and when makers can withdraw earned credit, are pending commercial
 * decisions, and nothing above 0 may be set before one is recorded in
 * `decision`. `PUBLISHED_PRICING.composedToolPlatformTakeBps` must equal
 * `platformTakeBps`; `standalone-pricing.test.ts` fails until they agree.
 */
export const COMPOSED_TOOL_FEES = {
	decision: {
		decidedOn: null,
		note: "No platform share on composed-tool fees is decided; makers earn the whole fee as spendable credit, and withdrawal is not offered.",
		status: "pending",
	},
	/** The platform's share of each run fee, in basis points (0 to 10,000). */
	platformTakeBps: 0,
} as const satisfies {
	decision: { decidedOn: string | null; note: string; status: string };
	platformTakeBps: number;
};

/**
 * The platform's share of one run fee, rounded down so the maker is never
 * short-changed, and the maker's net.
 */
export function composedToolFeeSplit(
	grossMicroUsd: number,
	platformTakeBps: number = COMPOSED_TOOL_FEES.platformTakeBps
): { netMicroUsd: number; platformTakeMicroUsd: number } {
	if (
		!(
			Number.isSafeInteger(grossMicroUsd) &&
			grossMicroUsd >= 0 &&
			Number.isInteger(platformTakeBps) &&
			platformTakeBps >= 0 &&
			platformTakeBps <= 10_000
		)
	) {
		throw new Error(
			"composed tool fee split needs a whole fee and 0-10,000 bps"
		);
	}
	const platformTakeMicroUsd = Math.floor(
		(grossMicroUsd * platformTakeBps) / 10_000
	);
	return {
		netMicroUsd: grossMicroUsd - platformTakeMicroUsd,
		platformTakeMicroUsd,
	};
}

/**
 * The one rate table for Ryu-hosted standalone services, charged against the
 * organization credit wallet by the control plane's hourly settlement (and, for
 * Mail overage, inline at send). Self-hosted services are never charged.
 *
 * `PUBLISHED_PRICING` in `@ryu/blocks/web/data/standalone-pricing.ts` mirrors
 * these figures for marketing copy, and `standalone-pricing.test.ts` fails
 * until the two agree. Change a rate here and in that mirror in one commit.
 *
 * Connect's row prices only toolkit calls it serves itself (native `rnx_`
 * receipts, ledger reason `connect_native`); its mirror is
 * `CONNECT_NATIVE_CALL_MICRO_USD` in `apps/connect/src/call-money.ts`, which
 * `service-usage-adapters.test.ts` reads. Each Composio execution receipt is
 * priced with the published Composio rates
 * (`crates/gateway/contracts/fixtures/composio-rates.json`), exactly as a call
 * made through Core is. Sites has no Ryu-hosted service and Hire has no
 * runtime, so neither is charged.
 */
export const SERVICE_RATES = {
	box: {
		meters: {
			/** $0.025 per hour of a running `small` Box (2 vCPU, 4 GiB). */
			boxSmallSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.small,
				perUnits: 3600,
			},
			/** $0.04 per hour of a running `default` Box (4 vCPU, 8 GiB). */
			boxDefaultSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.default,
				perUnits: 3600,
			},
			/** $0.07 per hour of a running `large` Box (8 vCPU, 16 GiB). */
			boxLargeSeconds: {
				freePerMonth: 0,
				microUsd: BOX_SIZE_MICRO_USD_PER_HOUR.large,
				perUnits: 3600,
			},
			/**
			 * Saved Box state (the measured, compressed bytes of each Box's
			 * newest working generation) at $0.05 per GiB-month (30 days, GiB =
			 * 2^30 bytes), above the organization's included Box storage
			 * ({@link boxIncludedStorageGib}). Byte-seconds, one exact line per
			 * Box, so any state size prices exactly before the single round-up.
			 */
			boxStateByteSeconds: {
				freePerMonth: 0,
				microUsd: BOX_STORAGE_MICRO_USD_PER_GIB_MONTH,
				perUnits: 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS,
			},
			/**
			 * Named snapshots at the same $0.05 per GiB-month on their measured
			 * size while the snapshot exists. Snapshots and saved state share the
			 * organization's included Box storage.
			 */
			snapshotByteSeconds: {
				freePerMonth: 0,
				microUsd: BOX_STORAGE_MICRO_USD_PER_GIB_MONTH,
				perUnits: 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS,
			},
		},
	},
	notify: {
		meters: {
			/** $0.10 per 1,000 events accepted, after 10,000 a month. */
			events: { freePerMonth: 10_000, microUsd: 100_000, perUnits: 1000 },
		},
	},
	passport: {
		meters: {
			/**
			 * $0.10 per connection-month (30 days) while a stored connection or MCP
			 * OAuth credential exists, after 5 connection-months a month.
			 */
			connectionSeconds: {
				freePerMonth: 5 * SERVICE_BILLING_MONTH_SECONDS,
				microUsd: 100_000,
				perUnits: SERVICE_BILLING_MONTH_SECONDS,
			},
			/** $0.10 per 1,000 runtime fetches that reach an upstream, after 10,000. */
			fetches: { freePerMonth: 10_000, microUsd: 100_000, perUnits: 1000 },
		},
	},
	connect: {
		meters: {
			/**
			 * $0.40 per 1,000 toolkit calls Connect serves itself (natively routed
			 * toolkits, `source: "native"` usage lines), with no free allowance.
			 * Composio project add-ons never apply to these calls.
			 */
			nativeCalls: { freePerMonth: 0, microUsd: 400, perUnits: 1 },
		},
	},
	mail: {
		meters: {
			/**
			 * $1.00 per 1,000 recipients sent beyond a paid plan's monthly
			 * allowance. The allowance is the plan's `emailMonthlySendLimit`, so no
			 * extra free units apply here; the free baseline never overflows.
			 */
			overageRecipients: {
				freePerMonth: 0,
				microUsd: 1_000_000,
				perUnits: 1000,
			},
		},
	},
} as const satisfies Record<
	string,
	{
		readonly meters: Readonly<Record<string, ServiceMeterRate>>;
	}
>;

/** A quantity of one meter, priced at its rate. */
export interface ServiceChargeLine {
	readonly quantity: number;
	readonly rate: Pick<ServiceMeterRate, "microUsd" | "perUnits">;
}

const greatestCommonDivisor = (a: bigint, b: bigint): bigint => {
	let left = a;
	let right = b;
	while (right !== 0n) {
		[left, right] = [right, left % right];
	}
	return left;
};

/**
 * The exact sum of `quantity * microUsd / perUnits` over every line, rounded UP
 * once to the next whole micro-USD. Summing exactly and rounding once means a
 * window of many small lines is charged what it used, never a micro-USD per
 * line. Quantities are non-negative safe integers (seconds, counts, recipients).
 */
export const serviceChargeMicroUsd = (
	lines: readonly ServiceChargeLine[]
): number => {
	let numerator = 0n;
	let denominator = 1n;
	for (const { quantity, rate } of lines) {
		if (!(Number.isSafeInteger(quantity) && quantity >= 0)) {
			throw new Error("service quantities must be non-negative integers");
		}
		if (
			!(
				Number.isSafeInteger(rate.microUsd) &&
				rate.microUsd >= 0 &&
				Number.isSafeInteger(rate.perUnits) &&
				rate.perUnits > 0
			)
		) {
			throw new Error("service rates must be non-negative integer fractions");
		}
		const per = BigInt(rate.perUnits);
		numerator =
			numerator * per + BigInt(quantity) * BigInt(rate.microUsd) * denominator;
		denominator *= per;
		const divisor = greatestCommonDivisor(numerator, denominator);
		if (divisor > 1n) {
			numerator /= divisor;
			denominator /= divisor;
		}
	}
	const charge = (numerator + denominator - 1n) / denominator;
	if (charge > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("service charge exceeds the safe billing range");
	}
	return Number(charge);
};

/**
 * The chargeable part of one window's quantity under a monthly free allowance:
 * `max(0, after - free) - max(0, before - free)`, where `before` is the
 * month-to-date quantity already settled and `after` adds this window.
 */
export const chargeableAfterFreeAllowance = (input: {
	freePerMonth: number;
	monthToDateBefore: number;
	quantity: number;
}): number => {
	const after = input.monthToDateBefore + input.quantity;
	return (
		Math.max(0, after - input.freePerMonth) -
		Math.max(0, input.monthToDateBefore - input.freePerMonth)
	);
};

const billingIntervalSchema = z.enum(["one_time", "monthly", "yearly"]);

/** The Polar product a row sells on for `interval`, or null when it sells none. */
export const bindingFor = (
	plan: PlanId,
	row: PlanVersion,
	interval: BillingInterval
): PolarBinding | null => {
	const own = row.bindings?.[interval];
	if (own) {
		return own;
	}
	if (row.version <= LEGACY_SHARED_PRODUCT_MAX_VERSION[plan]) {
		return PLANS[plan].bindings[interval] ?? null;
	}
	return null;
};

/**
 * What a Polar product id sells. `kind: "row"` is a product one version row
 * owns (authoritative); `kind: "legacy"` is a plan-level product shared by
 * every row up to {@link LEGACY_SHARED_PRODUCT_MAX_VERSION}, told apart by the
 * `planVersion` checkout stamp.
 */
export interface ProductIndexEntry {
	readonly interval: BillingInterval;
	readonly kind: "row" | "legacy";
	readonly plan: Plan;
	readonly rows: readonly PlanVersion[];
}

/** Index every product id the catalog sells (env-aware; re-read per call). */
export const planProductIndex = (
	read: (key: string) => string | undefined = (k) => process.env[k],
	versions: PlanVersionCatalog = PLAN_VERSIONS
): Map<string, ProductIndexEntry> => {
	const index = new Map<string, ProductIndexEntry>();
	for (const plan of ALL_PLANS) {
		const legacyRows = versions[plan.id].filter(
			(row) => row.version <= LEGACY_SHARED_PRODUCT_MAX_VERSION[plan.id]
		);
		for (const [interval, binding] of Object.entries(plan.bindings)) {
			index.set(resolveProductId(binding, read), {
				interval: billingIntervalSchema.parse(interval),
				kind: "legacy",
				plan,
				rows: legacyRows,
			});
		}
		for (const row of versions[plan.id]) {
			for (const [interval, binding] of Object.entries(row.bindings ?? {})) {
				index.set(resolveProductId(binding, read), {
					interval: billingIntervalSchema.parse(interval),
					kind: "row",
					plan,
					rows: [row],
				});
			}
		}
	}
	return index;
};

/**
 * Index from Polar product id → { plan, interval }. Built lazily from the
 * resolved (env-aware) ids so a subscription's `productId` can be mapped to a
 * plan. Re-reads env on each call so test/process env changes are honoured.
 * Includes the products a version row owns.
 */
export const planByProductId = (
	read: (key: string) => string | undefined = (k) => process.env[k]
): Map<string, { plan: Plan; interval: BillingInterval }> => {
	const index = new Map<string, { plan: Plan; interval: BillingInterval }>();
	for (const [productId, entry] of planProductIndex(read)) {
		index.set(productId, { plan: entry.plan, interval: entry.interval });
	}
	return index;
};

const PLAN_STAMP_INTERVAL_SUFFIX = /-(monthly|yearly|one_time)$/;

/**
 * The plan a checkout's `metadata.plan` stamp names. Checkout stamps the
 * product SLUG (`pro-monthly`, `teams-yearly`) and onboarding stamps the bare
 * plan id, so both forms resolve; anything else is no stamp at all.
 */
export const planIdFromStamp = (stamp: unknown): PlanId | null => {
	if (typeof stamp !== "string") {
		return null;
	}
	const raw = stamp.trim().toLowerCase();
	const bare = raw.replace(PLAN_STAMP_INTERVAL_SUFFIX, "");
	return PLAN_IDS.find((id) => id === raw || id === bare) ?? null;
};

/** How {@link resolveSubscriptionRow} chose a row. */
export type ResolveSource =
	| "product"
	| "metadata"
	| "foreign_stamp"
	| "fallback";

/** The version row one subscription is billed and entitled against. */
export interface ResolvedPlanRow {
	readonly cell: PlanVariantCell | null;
	readonly interval: BillingInterval;
	readonly plan: Plan;
	readonly row: PlanVersion;
	readonly source: ResolveSource;
	readonly variant: PlanVariant;
}

/** The subscription facts the row resolver reads. */
export interface SubscriptionRowInput {
	/** Stamped `metadata.plan`, when the checkout wrote one. */
	readonly planStamp?: string | null;
	/** Stamped `metadata.planVersion`. */
	readonly planVersion?: z.input<typeof planVersionInputSchema>;
	readonly productId?: string | null;
	/** Stamped `metadata.variant` (a cell key). */
	readonly variantStamp?: unknown;
}

/**
 * THE ONE SEAM that maps a subscription to its version row.
 *
 *  1. Unknown product: null (no entitlement, as before).
 *  2. A product a row owns: that row, whatever the metadata says. This is what
 *     makes a price migration work: Polar cannot re-stamp metadata, but the
 *     product changes, and the product is authoritative.
 *  3. A shared (legacy) product: the stamped version when it is one of that
 *     product's rows. A stamp from ANOTHER plan (the customer changed plan
 *     onto this product and kept their first plan's stamp) resolves to the
 *     newest legacy row and is reported as `foreign_stamp`, so a migration can
 *     refuse to act on a guessed row. Anything else falls back to the OLDEST
 *     row, exactly like {@link planVersionFor}.
 *
 * When no plan stamp is passed the result equals `planVersionFor(plan,
 * planVersion)` for every shared product (proven by test), so callers that do
 * not read the stamp keep today's behaviour.
 */
export const resolveSubscriptionRow = (
	sub: SubscriptionRowInput,
	read: (key: string) => string | undefined = (k) => process.env[k],
	versions: PlanVersionCatalog = PLAN_VERSIONS
): ResolvedPlanRow | null => {
	const productId = sub.productId ?? null;
	if (!productId) {
		return null;
	}
	const entry = planProductIndex(read, versions).get(productId);
	if (!entry) {
		return null;
	}
	let row: PlanVersion;
	let source: ResolveSource;
	const [ownRow] = entry.rows;
	if (entry.kind === "row" && ownRow) {
		row = ownRow;
		source = "product";
	} else {
		const stampPlan = planIdFromStamp(sub.planStamp);
		const wanted = planVersionInputSchema.parse(sub.planVersion);
		const stamped = entry.rows.find(
			(candidate) => candidate.version === wanted
		);
		const newest = entry.rows.at(-1);
		const oldest = entry.rows[0];
		if (stampPlan && stampPlan !== entry.plan.id && newest) {
			row = newest;
			source = "foreign_stamp";
		} else if (stamped) {
			row = stamped;
			source = "metadata";
		} else {
			// Restricted to this product's own rows: an unknown stamp never
			// resolves to a row sold on a different product.
			row = oldest ?? planVersionFor(entry.plan.id, sub.planVersion);
			source = "fallback";
		}
	}
	const variant = rowVariant(row);
	const stampedCell = parseCellKey(sub.variantStamp);
	const cell =
		stampedCell &&
		stampedCell.provider === variant.provider &&
		stampedCell.capacity === variant.capacity &&
		rowRegions(row).includes(stampedCell.region)
			? stampedCell
			: null;
	return {
		cell,
		interval: entry.interval,
		plan: entry.plan,
		row,
		source,
		variant,
	};
};

/**
 * A minimal, transport-agnostic view of a Polar subscription. Mirrors the
 * fields the billing router already reads off the Polar SDK object; kept loose
 * so callers don't need the full SDK type.
 */
export interface SubscriptionView {
	/**
	 * The plan stamped into SERVER-SET checkout metadata (`metadata.plan`). A
	 * plan change swaps only the Polar product and keeps the first plan's
	 * metadata, so this is what tells {@link resolveSubscriptionRow} that the
	 * `planVersion` stamp belongs to ANOTHER plan and must not pick a row.
	 */
	readonly planStamp?: string | null;
	/**
	 * The plan version stamped into SERVER-SET checkout metadata at purchase
	 * (`planVersion`). Absent on every subscription created before versioning
	 * existed, which {@link planVersionFor} resolves to v1 — the correct answer
	 * for them, since they are the oldest customers on the oldest prices.
	 */
	readonly planVersion?: z.input<typeof planVersionInputSchema>;
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
	/**
	 * The subscription is in its free trial (Polar `trialing`). It has the
	 * plan's features, but Box capacity and storage stay on the trial row
	 * (1 running Box, 10 GiB of storage) until it converts: a free trial is not
	 * a paid managed plan. Absent when false.
	 */
	readonly trialing?: boolean;
}

/**
 * Number of external channel users an entitlement may configure for hosted bots.
 * Only managed-inference plans may use hosted bots. Personal managed plans
 * resolve to one seat; Teams, Teams Lite, and Business resolve to the billed seat count.
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
			// customer still paying an older price. A product a version row owns
			// (a migrated subscription) resolves to that row through the product.
			const versioned =
				resolveSubscriptionRow(
					{
						planStamp: subscription.planStamp,
						productId: subscription.productId,
						planVersion: subscription.planVersion,
					},
					read
				)?.row ?? planVersionFor(plan.id, subscription.planVersion);
			const pool = monthlyCreditPoolMicroUsdForSeats({
				plan,
				seats,
				version: versioned,
			});
			const trialing = (subscription.status ?? "").toLowerCase() === "trialing";
			return {
				plan: plan.id,
				desktopAccess: plan.desktopAccess,
				marketplaceApps: plan.marketplaceApps,
				managedInference: plan.managedInference,
				monthlyCreditPoolMicroUsd: pool,
				seats,
				...(trialing ? { trialing: true } : {}),
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
 * Whether managed inference is available now: an active subscription with
 * included credits OR any positive prepaid wallet balance. A balance is the
 * paid standalone entitlement, so no managed plan, desktop license, or Ryu
 * cloud node is required. Requests still pass the existing pool and spend gates.
 */
export const managedInferenceAvailable = (
	entitlement: Entitlement,
	balanceMicroUsd: number
): boolean => entitlement.managedInference || balanceMicroUsd > 0;

/**
 * Per-minute ceilings the hosted Gateway enforces on an organization's managed
 * traffic. Many organizations share one Gateway node, so an organization on a
 * free baseline, a desktop license, or promotional credit must not be able to
 * consume the shared provider capacity a paid plan relies on. Admin-authored
 * org caps can only narrow these ceilings, never raise them. `/gateway/resolve`
 * sends the ceiling as `planRateCeiling`, and only a Gateway that bills tenants
 * applies it: a self-hosted Gateway or an organization's own node serves its
 * own capacity and enforces the authored caps alone.
 */
export interface GatewayRateCeiling {
	readonly rpm: number;
	readonly tpm: number;
}

/** Organizations without a managed plan: free baseline, promo or prepaid credit. */
const UNMANAGED_GATEWAY_RATE_CEILING: GatewayRateCeiling = {
	rpm: 30,
	tpm: 60_000,
};

/** Ceilings per plan; per-seat plans scale by the billed seat count. */
const GATEWAY_RATE_CEILING_BY_PLAN: Record<PlanId, GatewayRateCeiling> = {
	"desktop-license": UNMANAGED_GATEWAY_RATE_CEILING,
	"marketplace-membership": UNMANAGED_GATEWAY_RATE_CEILING,
	plus: { rpm: 60, tpm: 200_000 },
	pro: { rpm: 120, tpm: 400_000 },
	max: { rpm: 300, tpm: 1_000_000 },
	"teams-lite": { rpm: 60, tpm: 200_000 },
	teams: { rpm: 120, tpm: 400_000 },
	business: { rpm: 120, tpm: 400_000 },
};

/** Upper bounds matching the org-limits store (`MAX_LIMIT_RPM` / `MAX_LIMIT_TPM`). */
const MAX_GATEWAY_RPM = 1_000_000;
const MAX_GATEWAY_TPM = 1_000_000_000;

/**
 * The hosted Gateway rate ceiling for an entitlement. `null` (the entitlement
 * could not be read) gets the unmanaged ceiling; `/gateway/resolve` passes null
 * only when it has no earlier successful read for the org to reuse.
 */
export const gatewayRateCeilingForEntitlement = (
	entitlement: Entitlement | null
): GatewayRateCeiling => {
	if (!(entitlement?.plan && entitlement.managedInference)) {
		return UNMANAGED_GATEWAY_RATE_CEILING;
	}
	const ceiling = GATEWAY_RATE_CEILING_BY_PLAN[entitlement.plan];
	const seats =
		PLANS[entitlement.plan].seatModel.kind === "per_seat"
			? Math.max(1, entitlement.seats)
			: 1;
	return {
		rpm: Math.min(ceiling.rpm * seats, MAX_GATEWAY_RPM),
		tpm: Math.min(ceiling.tpm * seats, MAX_GATEWAY_TPM),
	};
};

// The desktop trial/paywall gate, the Agent Inbox lifecycle and the lifetime
// updates window live in their own modules; re-exported so `lib/plans` stays
// the single import path for the plan catalog.
export * from "./plan-desktop-gate.ts";
export * from "./plan-inbox-lifecycle.ts";
export * from "./plan-updates-window.ts";

/* -------------------------------------------------------------------------- *
 * Box concurrency caps (docs/box-per-session-desktop.md §8.1)
 * -------------------------------------------------------------------------- */

/**
 * How many Ryu Boxes one organization may run and keep stored at once, by plan
 * (founder sign-off 2026-10-20, design §18 question 2).
 *
 * The control plane signs them into the org's `rbx1` Box tenant token, where
 * the Box service enforces them, and into Core's `ryu_limits` JWT claim, where
 * Core uses them for UX and early refusal.
 *
 *  - `running` counts Boxes that are provisioning, ready, running or stopping.
 *    It is one number for the whole organization, whatever its seat count.
 *  - `stored` counts stopped Boxes. A `storedPerSeat` row multiplies it by the
 *    plan's seat count.
 *  - `trial` is the row for an org with no paid managed plan (design §8.1:
 *    the credit-only baseline is the trial row, 1 running Box), and for plans
 *    that carry no managed capacity (the desktop license and A Major Pass).
 *    A paid plan whose subscription is still `trialing` also gets it, with
 *    the trial storage (10 GiB, nothing sold beyond it), until it converts.
 */
export const PLAN_BOX_CONCURRENCY = Object.freeze({
	trial: { running: 1, stored: 3, storedPerSeat: false },
	plus: { running: 2, stored: 10, storedPerSeat: false },
	pro: { running: 2, stored: 20, storedPerSeat: false },
	max: { running: 4, stored: 40, storedPerSeat: false },
	"teams-lite": { running: 10, stored: 10, storedPerSeat: true },
	teams: { running: 10, stored: 20, storedPerSeat: true },
	business: { running: 20, stored: 20, storedPerSeat: true },
} as const satisfies Record<
	string,
	{ running: number; stored: number; storedPerSeat: boolean }
>);

/** A row of {@link PLAN_BOX_CONCURRENCY}. */
export type BoxConcurrencyTier = keyof typeof PLAN_BOX_CONCURRENCY;

/** One org's Box admission caps, as the tenant token carries them. */
export interface BoxConcurrencyLimits {
	/** Always `2 × maxRunning` (design §8.1). */
	maxResourceUnits: number;
	maxRunning: number;
	/**
	 * The most Box storage (saved state plus named snapshots) the tenant may
	 * hold, in GiB. Set only on the trial row, where storage beyond the
	 * included amount is not available; absent, storage above the included
	 * amount is sold.
	 */
	maxStorageGib?: number;
	maxStored: number;
}

/**
 * The largest cap a Box tenant token may carry (`apps/box/src/tenants.ts`
 * refuses a larger claim as malformed). Resource units are twice the running
 * cap, so running is bounded at half of it.
 */
export const BOX_CONCURRENCY_CLAIM_MAX = 100_000;

const BOX_TIER_BY_PLAN = {
	"desktop-license": "trial",
	"marketplace-membership": "trial",
	plus: "plus",
	pro: "pro",
	max: "max",
	teams: "teams",
	"teams-lite": "teams-lite",
	business: "business",
} as const satisfies Record<PlanId, BoxConcurrencyTier>;

/**
 * The concurrency row for a plan; `null` (no plan) is the trial row, and so
 * is any plan while its subscription is still in its free trial
 * (`trialing`), until it converts.
 */
export function boxConcurrencyTier(
	plan: PlanId | null,
	trialing = false
): BoxConcurrencyTier {
	return plan && !trialing ? BOX_TIER_BY_PLAN[plan] : "trial";
}

/**
 * The Box caps for an org on `plan` with `seats` billed seats. The running
 * cap is the plan's, whatever the seats. A per-seat stored cap with no
 * reported seats counts one seat, so a seat lookup that failed never yields a
 * zero cap that would refuse every stop.
 */
export function boxConcurrencyFor(
	plan: PlanId | null,
	seats: number,
	trialing = false
): BoxConcurrencyLimits {
	const tier = boxConcurrencyTier(plan, trialing);
	const row: { running: number; stored: number; storedPerSeat: boolean } =
		PLAN_BOX_CONCURRENCY[tier];
	const seatCount =
		row.storedPerSeat && Number.isSafeInteger(seats) && seats > 0 ? seats : 1;
	const maxRunning = Math.min(
		row.running,
		Math.floor(BOX_CONCURRENCY_CLAIM_MAX / 2)
	);
	const maxStored = Math.min(row.stored * seatCount, BOX_CONCURRENCY_CLAIM_MAX);
	return {
		maxResourceUnits: 2 * maxRunning,
		maxRunning,
		maxStored,
		...(tier === "trial"
			? { maxStorageGib: BOX_INCLUDED_STORAGE_GIB.trial }
			: {}),
	};
}

/** The Box caps an entitlement grants. */
export function boxConcurrencyForEntitlement(
	entitlement: Pick<Entitlement, "plan" | "seats" | "trialing">
): BoxConcurrencyLimits {
	return boxConcurrencyFor(
		entitlement.plan,
		entitlement.seats,
		entitlement.trialing === true
	);
}

/* -------------------------------------------------------------------------- *
 * The signed `ryu_limits` Core claim
 * -------------------------------------------------------------------------- */

/**
 * JWT claim Better Auth's `definePayload` (`../index.ts`) adds beside
 * `ryu_flags`: `{ boxConcurrency }`, the running-Box cap of the org the flags
 * were evaluated for. Core parses it into `VerifiedLimits` and refuses a new
 * session Box early when the owner is at the cap; the Box service enforces the
 * same cap from the tenant token whatever Core does. A missing claim means
 * "unknown", and Core falls through to the Box service's own limits.
 */
export const CORE_LIMITS_CLAIM = "ryu_limits" as const;

/** The claim's value. */
export interface CoreLimitsClaim {
	boxConcurrency: number;
}

/**
 * The plan of an org, as `@ryu/api` resolves it. Registered at boot because
 * the resolver lives in `@ryu/api`, which depends on this package (the same
 * reason `registerCoreFlagClaimResolver` exists).
 */
export type CoreLimitsPlanResolver = (
	organizationId: string
) => Promise<Pick<Entitlement, "plan" | "seats" | "trialing">>;

let coreLimitsPlanResolver: CoreLimitsPlanResolver | null = null;

/** Install the plan resolver for the `ryu_limits` claim. Single slot, last wins. */
export function registerCoreLimitsPlanResolver(
	implementation: CoreLimitsPlanResolver | null
): void {
	coreLimitsPlanResolver = implementation;
}

const CORE_LIMITS_TIMEOUT_MS = 2000;
const CORE_LIMITS_TIMED_OUT = Symbol("core-limits-claim-timeout");

/**
 * The `ryu_limits` claim for `organizationId`, or null when there is no org,
 * no registered resolver, or the plan could not be read in time. NEVER THROWS
 * AND NEVER REJECTS: its caller mints every token, so a failure omits the
 * claim rather than delaying or failing sign-in.
 */
export async function resolveCoreLimitsClaim(
	organizationId: string | null,
	timeoutMs: number = CORE_LIMITS_TIMEOUT_MS
): Promise<CoreLimitsClaim | null> {
	const implementation = coreLimitsPlanResolver;
	if (!(organizationId && implementation)) {
		return null;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const entitlement = await Promise.race([
			implementation(organizationId),
			new Promise<typeof CORE_LIMITS_TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(CORE_LIMITS_TIMED_OUT), timeoutMs);
			}),
		]);
		if (entitlement === CORE_LIMITS_TIMED_OUT) {
			console.error("[auth] core limits claim: plan lookup timed out");
			return null;
		}
		return {
			boxConcurrency: boxConcurrencyForEntitlement(entitlement).maxRunning,
		};
	} catch (error) {
		console.error("[auth] core limits claim: plan lookup failed:", error);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Add the claim to a JWT payload; a null claim leaves the payload unchanged. */
export function withCoreLimitsClaim<T extends object>(
	payload: T,
	claim: CoreLimitsClaim | null
): T & { [CORE_LIMITS_CLAIM]?: CoreLimitsClaim } {
	if (!claim) {
		return payload;
	}
	return {
		...payload,
		[CORE_LIMITS_CLAIM]: { boxConcurrency: claim.boxConcurrency },
	};
}
