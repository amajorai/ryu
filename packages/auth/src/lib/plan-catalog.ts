import { type Plan, type PlanId, usdToMicro } from "./plan-core.ts";
import { includedCreditPoolMicroUsd } from "./plan-fees.ts";
import {
	BUSINESS_SEAT_PRICE_TIERS,
	TEAMS_LITE_SEAT_PRICE_TIERS,
} from "./plan-seat-pricing.ts";
import { PLAN_MONTHLY_PRICE_MICRO_USD } from "./plan-version-catalog.ts";

/** Plan catalog part: The plan catalog (`PLANS`). Re-exported by `plans.ts`. */

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
