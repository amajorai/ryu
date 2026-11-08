import { z } from "zod";
import type { PlanSeatPriceTier } from "./plan-seat-pricing.ts";

/** Plan catalog part: Units, plan ids, plan shape and Polar bindings. Re-exported by `plans.ts`. */

// One micro-USD is a millionth of a dollar; the unit the credit wallet stores.
export const MICRO_USD_PER_USD = 1_000_000;

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
