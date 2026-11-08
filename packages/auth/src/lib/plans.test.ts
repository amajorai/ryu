import { describe, expect, it } from "bun:test";
import {
	channelUserLimitForEntitlement,
	currentPlanVersionFor,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	depositFee,
	EMAIL_QUOTA_FREE,
	emailQuotaForPlan,
	emailStorageLimitBytes,
	emailUsesFreeBaseline,
	managedInferenceAvailable,
	PLAN_IDS,
	PLANS,
	type PolarBinding,
	planByProductId,
	planLimit,
	planVersionFor,
	resolveEntitlement,
	resolveProductId,
	usdToMicro,
} from "./plans.ts";

// A reader that ignores env so tests use the catalog's documented defaults.
const defaultsOnly = (): undefined => undefined;

function requireBinding(
	binding: PolarBinding | undefined,
	name: string
): PolarBinding {
	if (!binding) {
		throw new Error(`Missing plan binding: ${name}`);
	}
	return binding;
}

describe("depositFee (max of the plan rate or the $5 floor)", () => {
	it("charges the floor on a zero/negative amount", () => {
		expect(depositFee(0)).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
		expect(depositFee(-100)).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
	});

	it("charges the 27% percentage when it exceeds the floor", () => {
		// $100 top-up: 27% = $27.00 (> $5 floor) -> $27.00.
		expect(depositFee(usdToMicro(100))).toBe(usdToMicro(27));
	});

	it("keeps the $5 floor at the $18 point below the 27% crossover", () => {
		// $18 top-up: 27% = $4.86, so the $5 floor still applies.
		expect(depositFee(usdToMicro(18))).toBe(usdToMicro(5));
	});

	it("the $5 floor dominates below the crossover (nudges bigger top-ups)", () => {
		// $5 pack: 27% = $1.35, but the floor is $5 (100% effective). The
		// floor keeps the conservative provider-cost curve profitable.
		expect(depositFee(usdToMicro(5))).toBe(usdToMicro(5));
		expect(depositFee(usdToMicro(1))).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
	});
});

describe("current Pro pricing", () => {
	it("uses the margin-safe $49/$490 ladder for new contracts", () => {
		expect(PLANS.pro.monthlyPriceMicroUsd).toBe(usdToMicro(49));
		expect(currentPlanVersionFor("pro")).toBe(7);
		expect(PLANS.pro.monthlyCreditPoolMicroUsd).toBe(usdToMicro(14));
		expect(planVersionFor("pro", currentPlanVersionFor("pro"))).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(14),
			version: 7,
		});
	});

	it("gives the never-sold $49 v6 row the margin-safe $14 pool", () => {
		expect(planVersionFor("pro", 6)).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(14),
			version: 6,
		});
	});

	it("gives the never-sold $39 Pro rows the $9 pool that clears the floor", () => {
		for (const version of [1, 4, 5]) {
			expect(planVersionFor("pro", version)).toMatchObject({
				monthlyPriceMicroUsd: usdToMicro(39),
				monthlyCreditPoolMicroUsd: usdToMicro(9),
				version,
			});
		}
	});
});

describe("current Plus pricing", () => {
	it("uses the private lower-usage $39/$390 ladder", () => {
		expect(PLAN_IDS.indexOf("plus")).toBeLessThan(PLAN_IDS.indexOf("pro"));
		expect(PLANS.plus.monthlyPriceMicroUsd).toBe(usdToMicro(39));
		expect(PLANS.plus.monthlyCreditPoolMicroUsd).toBe(usdToMicro(9));
		expect(PLANS.plus.audience).toBe("individual");
		expect(PLANS.plus.seatModel).toEqual({ kind: "single" });
		expect(currentPlanVersionFor("plus")).toBe(2);
		expect(planVersionFor("plus", currentPlanVersionFor("plus"))).toMatchObject(
			{
				monthlyPriceMicroUsd: usdToMicro(39),
				monthlyCreditPoolMicroUsd: usdToMicro(9),
				version: 2,
			}
		);
	});

	it("gives the never-sold v1 row the same $9 pool as v2", () => {
		expect(planVersionFor("plus", 1)).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(9),
			version: 1,
		});
	});
});

describe("emailQuotaForPlan (Agent Inboxes)", () => {
	it("gives the free baseline a small branded growth-loop allowance", () => {
		expect(emailQuotaForPlan(null)).toEqual(EMAIL_QUOTA_FREE);
		expect(emailQuotaForPlan(null)).toMatchObject({
			enabled: true,
			inboxLimit: 1,
			aliasLimit: 3,
			monthlySendLimit: 50,
		});
	});

	it("keeps the free baseline for plans that add no hosted mail (desktop license, A Major Pass)", () => {
		for (const plan of ["desktop-license", "marketplace-membership"] as const) {
			expect(PLANS[plan].emailEnabled).toBe(false);
			expect(emailUsesFreeBaseline(plan)).toBe(true);
			expect(emailQuotaForPlan(plan)).toEqual(EMAIL_QUOTA_FREE);
			expect(emailStorageLimitBytes(plan)).toBe(
				EMAIL_QUOTA_FREE.storageLimitBytes
			);
		}
		expect(emailUsesFreeBaseline(null)).toBe(true);
		expect(emailUsesFreeBaseline("pro")).toBe(false);
	});

	it("expresses storage in GiB, matching the published allowance", () => {
		expect(EMAIL_QUOTA_FREE.storageLimitBytes).toBe(1024 ** 3);
		expect(emailQuotaForPlan("pro").storageLimitBytes).toBe(10 * 1024 ** 3);
		expect(emailQuotaForPlan("plus").storageLimitBytes).toBe(10 * 1024 ** 3);
		expect(emailQuotaForPlan("max").storageLimitBytes).toBe(100 * 1024 ** 3);
	});

	it("never trims a paid mail or Space allowance below the free baseline", () => {
		for (const plan of Object.values(PLANS)) {
			const quota = emailQuotaForPlan(plan.id);
			expect(quota.monthlySendLimit).toBeGreaterThanOrEqual(
				EMAIL_QUOTA_FREE.monthlySendLimit
			);
			expect(quota.storageLimitBytes).toBeGreaterThanOrEqual(
				EMAIL_QUOTA_FREE.storageLimitBytes
			);
			expect(planLimit(plan.id, "spaceStorageLimitGb")).toBeGreaterThanOrEqual(
				planLimit(null, "spaceStorageLimitGb")
			);
		}
	});

	it("enables email on every paid subscription plan", () => {
		for (const plan of [
			"pro",
			"plus",
			"max",
			"teams",
			"teams-lite",
			"business",
		] as const) {
			const q = emailQuotaForPlan(plan);
			expect(q.enabled).toBe(true);
			expect(q.inboxLimit).toBeGreaterThan(0);
			expect(q.monthlySendLimit).toBeGreaterThan(0);
		}
	});

	it("gives the free baseline three agent aliases and every mail plan unlimited", () => {
		expect(emailQuotaForPlan(null).aliasLimit).toBe(3);
		expect(EMAIL_QUOTA_FREE.aliasLimit).toBe(3);
		for (const plan of Object.values(PLANS)) {
			if (plan.emailEnabled) {
				expect(plan.emailAliasLimit).toBe(Number.POSITIVE_INFINITY);
				expect(emailQuotaForPlan(plan.id).aliasLimit).toBe(
					Number.POSITIVE_INFINITY
				);
			} else {
				expect(plan.emailAliasLimit).toBe(0);
				expect(emailQuotaForPlan(plan.id).aliasLimit).toBe(3);
			}
		}
		// A Major Pass adds no mail, so its holder keeps the free baseline.
		expect(emailQuotaForPlan("marketplace-membership").aliasLimit).toBe(3);
	});

	it("mirrors the plan catalog numbers exactly (single source of truth)", () => {
		const q = emailQuotaForPlan("pro");
		expect(q.inboxLimit).toBe(PLANS.pro.emailInboxLimit);
		expect(q.aliasLimit).toBe(PLANS.pro.emailAliasLimit);
		expect(q.monthlySendLimit).toBe(PLANS.pro.emailMonthlySendLimit);
		expect(q.enabled).toBe(PLANS.pro.emailEnabled);
	});
});

describe("resolveEntitlement — subscriptions", () => {
	it("separates Marketplace access from publisher-pool funding", () => {
		expect(PLANS["marketplace-membership"].marketplaceApps).toBe(true);
		expect(PLANS["marketplace-membership"].name).toBe("A Major Pass");
		expect(PLANS["marketplace-membership"].monthlyPriceMicroUsd).toBe(
			usdToMicro(20)
		);
		expect(PLANS["marketplace-membership"].seatModel).toEqual({
			kind: "single",
		});
		expect(PLANS["marketplace-membership"].bindings.yearly).toEqual({
			productIdEnv: "POLAR_PRODUCT_MARKETPLACE_MEMBERSHIP_YEARLY",
			productIdDefault: "polar_product_marketplace_membership_yearly",
		});
		const yearlyProductId = resolveProductId(
			requireBinding(
				PLANS["marketplace-membership"].bindings.yearly,
				"marketplace-membership.yearly"
			),
			defaultsOnly
		);
		expect(planByProductId(defaultsOnly).get(yearlyProductId)?.interval).toBe(
			"yearly"
		);
		expect(currentPlanVersionFor("marketplace-membership")).toBe(6);
		expect(PLANS.pro.marketplaceApps).toBe(true);
		expect(PLANS.max.marketplaceApps).toBe(true);
		expect(PLANS.teams.marketplaceApps).toBe(true);
		expect(PLANS["marketplace-membership"].marketplacePublisherPool).toBe(true);
		for (const id of [
			"pro",
			"plus",
			"max",
			"teams",
			"teams-lite",
			"business",
		] as const) {
			expect(PLANS[id].marketplacePublisherPool).toBe(false);
		}
		expect(PLANS["desktop-license"].marketplaceApps).toBe(false);
	});

	it("resolves A Major Pass as one individual user without unrelated capabilities", () => {
		const binding = requireBinding(
			PLANS["marketplace-membership"].bindings.monthly,
			"marketplace-membership.monthly"
		);
		const entitlement = resolveEntitlement(
			{
				productId: resolveProductId(binding, defaultsOnly),
				seats: 3,
				status: "active",
			},
			null,
			defaultsOnly
		);
		expect(entitlement.plan).toBe("marketplace-membership");
		expect(entitlement.marketplaceApps).toBe(true);
		expect(entitlement.desktopAccess).toBe(false);
		expect(entitlement.managedInference).toBe(false);
		expect(entitlement.monthlyCreditPoolMicroUsd).toBe(0);
		expect(entitlement.seats).toBe(1);
		expect(channelUserLimitForEntitlement(entitlement)).toBe(0);
		expect(managedInferenceAvailable(entitlement, 0)).toBe(false);
		expect(managedInferenceAvailable(entitlement, usdToMicro(100))).toBe(true);
		expect(emailQuotaForPlan("marketplace-membership")).toEqual(
			EMAIL_QUOTA_FREE
		);
	});

	it("resolves a plan-change subscription by its product, not another plan's stamp", () => {
		const proProduct = resolveProductId(
			requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
			defaultsOnly
		);
		// Checked out as Plus (stamp "plus-monthly", version 2), then switched to
		// Pro: only the product changed. Pro v2 is a $50 pool and must not apply.
		const entitlement = resolveEntitlement(
			{
				planStamp: "plus-monthly",
				planVersion: "2",
				productId: proProduct,
				status: "active",
			},
			null,
			defaultsOnly
		);
		expect(entitlement.plan).toBe("pro");
		expect(entitlement.monthlyCreditPoolMicroUsd).toBe(
			planVersionFor("pro", currentPlanVersionFor("pro"))
				.monthlyCreditPoolMicroUsd
		);
		expect(entitlement.monthlyCreditPoolMicroUsd).not.toBe(usdToMicro(50));
	});

	it("does not mark a desktop license for the Marketplace publisher pool", () => {
		const entitlement = resolveEntitlement(
			null,
			{ active: true },
			defaultsOnly
		);
		expect(entitlement.plan).toBe("desktop-license");
		expect(entitlement.marketplaceApps).toBe(false);
	});

	it("returns the un-entitled baseline for no inputs", () => {
		const e = resolveEntitlement(null, null, defaultsOnly);
		expect(e.plan).toBeNull();
		expect(e.desktopAccess).toBe(false);
		expect(e.managedInference).toBe(false);
		expect(e.monthlyCreditPoolMicroUsd).toBe(0);
		expect(e.seats).toBe(0);
	});

	it("resolves an active Pro subscription with its credit pool", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("pro");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(true);
		// Unstamped resolves to v1, which now carries the $9 margin-safe pool.
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(9));
		expect(e.seats).toBe(1);
	});

	it("resolves an active Max yearly subscription", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.yearly, "max.yearly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "trialing" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("max");
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(30));
	});

	it("ignores an inactive (canceled) subscription", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "canceled" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBeNull();
	});

	it("ignores an unknown product id", () => {
		const e = resolveEntitlement(
			{ productId: "not-a-real-product", status: "active" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBeNull();
	});
});
