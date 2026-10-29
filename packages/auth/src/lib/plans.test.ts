import { describe, expect, it } from "bun:test";
import {
	type CachedEntitlement,
	canRemovePoweredByRyu,
	capabilityTier,
	channelUserLimitForEntitlement,
	currentPlanVersionFor,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DESKTOP_GATE,
	type DesktopGateConfig,
	type DesktopGateInput,
	decideDesktopAccess,
	decideUpdateEligibility,
	depositFee,
	desktopGateConfig,
	EMAIL_QUOTA_FREE,
	type Entitlement,
	emailQuotaForPlan,
	emailStorageLimitBytes,
	emailUsesFreeBaseline,
	FREE_TIER_LIMITS,
	GATED_CAPABILITIES,
	gatewayRateCeilingForEntitlement,
	KERNEL_QUOTAS,
	MAIL_LIFECYCLE,
	managedInferenceAvailable,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLAN_IDS,
	PLANS,
	type PlanLimitField,
	type PolarBinding,
	planByProductId,
	planLimit,
	planVersionFor,
	QUOTAS,
	quotaOwner,
	resolveEntitlement,
	resolveInboxLifecycle,
	resolveProductId,
	UPDATES_WINDOW,
	updatesCutoffMs,
	updatesWindowApplies,
	updatesWindowEndMs,
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

	it("keeps the $15 pool for contracts sold before the 2026-10-20 trim", () => {
		expect(planVersionFor("pro", 6)).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(49),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			version: 6,
		});
	});

	it("keeps the previous Pro price available for grandfathered contracts", () => {
		expect(planVersionFor("pro", 4)).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(15),
			version: 4,
		});
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

	it("keeps the $10 pool for contracts sold before the 2026-10-20 trim", () => {
		expect(planVersionFor("plus", 1)).toMatchObject({
			monthlyPriceMicroUsd: usdToMicro(39),
			monthlyCreditPoolMicroUsd: usdToMicro(10),
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
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(15));
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

describe("plan audience — personal versus organization ownership", () => {
	it("keeps Pro, Plus, and Max personal while organization plans own the shared boundary", () => {
		expect(PLANS.pro.audience).toBe("individual");
		expect(PLANS.plus.audience).toBe("individual");
		expect(PLANS.max.audience).toBe("individual");
		expect(PLANS.teams.audience).toBe("organization");
		expect(PLANS["teams-lite"].audience).toBe("organization");
		expect(PLANS["teams-lite"].seatModel).toEqual({
			kind: "per_seat",
			minSeats: 5,
		});
		expect(PLANS["teams-lite"].monthlyCreditPoolMicroUsd).toBe(usdToMicro(20));
		expect(currentPlanVersionFor("teams-lite")).toBe(1);
		expect(PLANS.business.audience).toBe("organization");
		expect(PLANS.business.seatModel).toEqual({
			kind: "per_seat",
			minSeats: 5,
		});
		expect(PLANS.business.monthlyCreditPoolMicroUsd).toBe(usdToMicro(100));
		expect(currentPlanVersionFor("business")).toBe(2);
		expect(PLANS.business.creditPoolModel).toBe("per_completed_bundle");
	});

	it("resolves Business products and its graduated monthly quote", () => {
		const binding = requireBinding(
			PLANS.business.bindings.monthly,
			"business.monthly"
		);
		const productId = resolveProductId(binding, defaultsOnly);
		expect(planByProductId(defaultsOnly).get(productId)?.plan.id).toBe(
			"business"
		);
		expect(
			monthlyPriceMicroUsdForSeats({
				plan: PLANS.business,
				seats: 5,
				version: planVersionFor("business"),
			})
		).toBe(usdToMicro(300));
		expect(
			monthlyPriceMicroUsdForSeats({
				plan: PLANS.business,
				seats: 6,
				version: planVersionFor("business"),
			})
		).toBe(usdToMicro(350));
	});

	it("resolves the private Teams Lite price and lower usage pool", () => {
		const binding = requireBinding(
			PLANS["teams-lite"].bindings.monthly,
			"teams-lite.monthly"
		);
		const productId = resolveProductId(binding, defaultsOnly);
		const entitlement = resolveEntitlement(
			{ productId, status: "active", seats: 5 },
			null,
			defaultsOnly
		);
		expect(planByProductId(defaultsOnly).get(productId)?.plan.id).toBe(
			"teams-lite"
		);
		expect(entitlement.plan).toBe("teams-lite");
		expect(entitlement.seats).toBe(5);
		expect(entitlement.monthlyCreditPoolMicroUsd).toBe(usdToMicro(20));
		expect(
			monthlyPriceMicroUsdForSeats({
				plan: PLANS["teams-lite"],
				seats: 5,
				version: planVersionFor("teams-lite"),
			})
		).toBe(usdToMicro(150));
		expect(
			monthlyPriceMicroUsdForSeats({
				plan: PLANS["teams-lite"],
				seats: 6,
				version: planVersionFor("teams-lite"),
			})
		).toBe(usdToMicro(200));
	});

	it("resolves the private Plus price and lower usage pool", () => {
		const binding = requireBinding(PLANS.plus.bindings.monthly, "plus.monthly");
		const productId = resolveProductId(binding, defaultsOnly);
		const entitlement = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(planByProductId(defaultsOnly).get(productId)?.plan.id).toBe("plus");
		expect(entitlement.plan).toBe("plus");
		expect(entitlement.seats).toBe(1);
		expect(entitlement.monthlyCreditPoolMicroUsd).toBe(usdToMicro(10));
		expect(PLANS.plus.bindings.yearly).toEqual({
			productIdEnv: "POLAR_PRODUCT_PLUS_YEARLY",
			productIdDefault: "polar_product_plus_yearly",
		});
	});

	it("keeps the Business pool stable until a complete five-seat bundle", () => {
		const plan = PLANS.business;
		const current = planVersionFor(
			"business",
			currentPlanVersionFor("business")
		);
		expect(
			monthlyPriceMicroUsdForSeats({ plan, seats: 6, version: current })
		).toBe(usdToMicro(350));
		// v2: 5–9 seats receive one $100 pool; the next grant begins at 10.
		expect(
			monthlyCreditPoolMicroUsdForSeats({ plan, seats: 6, version: current })
		).toBe(usdToMicro(100));
		expect(
			monthlyCreditPoolMicroUsdForSeats({ plan, seats: 10, version: current })
		).toBe(usdToMicro(200));
		expect(
			monthlyCreditPoolMicroUsdForSeats({ plan, seats: 25, version: current })
		).toBe(usdToMicro(500));
		// v1 remains the grandfathered ceiling semantics.
		expect(
			monthlyCreditPoolMicroUsdForSeats({
				plan,
				seats: 6,
				version: planVersionFor("business", 1),
			})
		).toBe(usdToMicro(200));
	});
});

describe("resolveEntitlement — Teams member-seat billing with bundled org credits", () => {
	const teamsProduct = () =>
		resolveProductId(
			requireBinding(PLANS.teams.bindings.monthly, "teams.monthly"),
			defaultsOnly
		);

	it("resolves the billed seat count while keeping credits pooled", () => {
		const e = resolveEntitlement(
			{
				planVersion: currentPlanVersionFor("teams"),
				productId: teamsProduct(),
				status: "active",
				seats: 5,
			},
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("teams");
		expect(e.seats).toBe(5);
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(50));
	});

	it("adds $50 for every additional five billed seats", () => {
		const ten = resolveEntitlement(
			{
				planVersion: currentPlanVersionFor("teams"),
				productId: teamsProduct(),
				status: "active",
				seats: 10,
			},
			null,
			defaultsOnly
		);
		const eleven = resolveEntitlement(
			{
				planVersion: currentPlanVersionFor("teams"),
				productId: teamsProduct(),
				status: "active",
				seats: 11,
			},
			null,
			defaultsOnly
		);
		expect(ten.monthlyCreditPoolMicroUsd).toBe(usdToMicro(100));
		expect(eleven.monthlyCreditPoolMicroUsd).toBe(usdToMicro(150));
	});

	it("enforces the five-seat floor when a smaller count is supplied", () => {
		const e = resolveEntitlement(
			{ productId: teamsProduct(), status: "active", seats: 1 },
			null,
			defaultsOnly
		);
		expect(e.seats).toBe(5);
		expect(e.monthlyCreditPoolMicroUsd).toBe(
			planVersionFor("teams").monthlyCreditPoolMicroUsd
		);
	});

	it("accepts Polar quantity as a seat-count fallback", () => {
		const e = resolveEntitlement(
			{ productId: teamsProduct(), status: "active", quantity: 4 },
			null,
			defaultsOnly
		);
		expect(e.seats).toBe(5);
	});
});

describe("channelUserLimitForEntitlement", () => {
	it("allows one configured channel user on personal managed plans", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.monthly, "max.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(channelUserLimitForEntitlement(e)).toBe(1);
	});

	it("does not grant a hosted channel user to A Major Pass", () => {
		const productId = resolveProductId(
			requireBinding(
				PLANS["marketplace-membership"].bindings.monthly,
				"marketplace-membership.monthly"
			),
			defaultsOnly
		);
		const entitlement = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(channelUserLimitForEntitlement(entitlement)).toBe(0);
	});

	it("allows one hosted channel user per billed Teams seat", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.teams.bindings.monthly, "teams.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active", seats: 7 },
			null,
			defaultsOnly
		);
		expect(channelUserLimitForEntitlement(e)).toBe(7);
	});

	it("does not grant hosted channel users to free or desktop-license entitlements", () => {
		expect(
			channelUserLimitForEntitlement(
				resolveEntitlement(null, null, defaultsOnly)
			)
		).toBe(0);
		expect(
			channelUserLimitForEntitlement(
				resolveEntitlement(null, { active: true }, defaultsOnly)
			)
		).toBe(0);
	});
});

describe("resolveEntitlement — desktop license", () => {
	it("grants desktop access with no managed inference", () => {
		const e = resolveEntitlement(null, { active: true }, defaultsOnly);
		expect(e.plan).toBe("desktop-license");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(false);
		expect(e.monthlyCreditPoolMicroUsd).toBe(0);
		expect(e.seats).toBe(1);
	});

	it("ignores an inactive license", () => {
		const e = resolveEntitlement(null, { active: false }, defaultsOnly);
		expect(e.plan).toBeNull();
	});

	it("prefers an active subscription over a license", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.monthly, "max.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			{ active: true },
			defaultsOnly
		);
		expect(e.plan).toBe("max");
		expect(e.managedInference).toBe(true);
	});
});

describe("resolveProductId — env override", () => {
	it("prefers the env value over the default", () => {
		const read = (k: string): string | undefined =>
			k === "POLAR_PRODUCT_PRO_MONTHLY" ? "env-override-id" : undefined;
		expect(
			resolveProductId(
				requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
				read
			)
		).toBe("env-override-id");
	});

	it("falls back to the documented default when env is unset", () => {
		expect(
			resolveProductId(
				requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
				defaultsOnly
			)
		).toBe("ecf08edd-a677-4a6e-a618-53918e282298");
	});
});

describe("decideDesktopAccess (trial + paywall gate)", () => {
	const NOW = 1_000_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(10),
		seats: 1,
	};
	const licenseEnt: Entitlement = {
		plan: "desktop-license",
		desktopAccess: true,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const noneEnt: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};

	const base: DesktopGateInput = {
		firstLaunchMs: NOW - 30 * DAY, // trial long over
		liveEntitlement: noneEnt,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	};

	// The paid gate. This now equals the shipped default (betaFree: false), but
	// we pin it explicitly so these trial/paywall assertions stay correct even if
	// the break-glass flag is ever flipped on in the default config.
	const PAID_GATE: DesktopGateConfig = { ...DESKTOP_GATE, betaFree: false };

	it("unlocks via an active subscription with managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: sub });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("subscription");
	});

	it("unlocks via a desktop license but withholds managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: licenseEnt });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
		expect(v.reason).toBe("license");
	});

	it("unlocks via a freshly validated license key when live lags", () => {
		const v = decideDesktopAccess({ ...base, licenseActive: true });
		expect(v.proUnlocked).toBe(true);
		expect(v.plan).toBe("desktop-license");
		expect(v.reason).toBe("license");
	});

	it("grants full access inside the 7-day trial", () => {
		const v = decideDesktopAccess(
			{ ...base, firstLaunchMs: NOW - 2 * DAY },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("trial");
		expect(v.daysLeftInTrial).toBe(5);
	});

	it("treats a missing first-launch as a fresh trial (no false lockout)", () => {
		const v = decideDesktopAccess({ ...base, firstLaunchMs: null }, PAID_GATE);
		expect(v.proUnlocked).toBe(true);
		expect(v.reason).toBe("trial");
		expect(v.daysLeftInTrial).toBe(7);
	});

	it("paywalls after trial expiry with no sub/license", () => {
		const v = decideDesktopAccess(base, PAID_GATE);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
		expect(v.reason).toBe("trial-expired");
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("rides the offline grace window on a failed live check with fresh cache", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 3 * DAY,
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const v = decideDesktopAccess(
			{
				...base,
				liveEntitlement: null, // live check failed (offline)
				cached,
			},
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.reason).toBe("offline-grace");
	});

	it("locks once the offline grace window has lapsed", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 10 * DAY, // older than the 7-day grace
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const v = decideDesktopAccess(
			{ ...base, liveEntitlement: null, cached },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
	});

	it("does not grant offline grace from a non-Pro cache", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 1 * DAY,
			marketplaceApps: false,
			proUnlocked: false,
			managedInference: false,
			plan: null,
		};
		const v = decideDesktopAccess(
			{ ...base, liveEntitlement: null, cached },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
	});
});

describe("decideDesktopAccess — betaFree break-glass flag (off by default)", () => {
	const NOW = 1_000_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	const noneEnt: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};
	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(10),
		seats: 1,
	};

	// Trial long over, no sub/license — paywalled under the shipped default;
	// unlocked only when the break-glass flag is explicitly turned on.
	const expired: DesktopGateInput = {
		firstLaunchMs: NOW - 30 * DAY,
		liveEntitlement: noneEnt,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	};
	const BETA_ON: DesktopGateConfig = { ...DESKTOP_GATE, betaFree: true };

	it("paywalls an expired user under the shipped default (no free Pro)", () => {
		const v = decideDesktopAccess(expired);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
		expect(v.reason).toBe("trial-expired");
	});

	it("unlocks Pro for everyone only when the flag is explicitly on", () => {
		const v = decideDesktopAccess(expired, BETA_ON);
		expect(v.proUnlocked).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("beta");
	});

	it("withholds managed inference even under the beta flag (no free cloud spend)", () => {
		const v = decideDesktopAccess(expired, BETA_ON);
		expect(v.managedInference).toBe(false);
		expect(v.plan).toBe(null);
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("maps the desktop trial rollout flag onto betaFree", () => {
		expect(desktopGateConfig(true)).toEqual(DESKTOP_GATE);
		expect(desktopGateConfig(false).betaFree).toBe(true);
		const trialOff = decideDesktopAccess(expired, desktopGateConfig(false));
		expect(trialOff.reason).toBe("beta");
		expect(trialOff.paywalled).toBe(false);
		const paidTrialOff = decideDesktopAccess(
			{ ...expired, liveEntitlement: sub },
			desktopGateConfig(false)
		);
		expect(paidTrialOff.reason).toBe("subscription");
		expect(paidTrialOff.managedInference).toBe(true);
	});

	it("keeps an offline subscriber's cached plan under the beta flag", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 1 * DAY,
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const offline = decideDesktopAccess(
			{ ...expired, liveEntitlement: null, cached },
			desktopGateConfig(false)
		);
		expect(offline.reason).toBe("offline-grace");
		expect(offline.plan).toBe("pro");
		expect(offline.managedInference).toBe(true);

		const betaCache = decideDesktopAccess(
			{
				...expired,
				liveEntitlement: null,
				cached: { ...cached, managedInference: false, plan: null },
			},
			desktopGateConfig(false)
		);
		expect(betaCache.reason).toBe("beta");
	});

	it("never shows a trial countdown under the beta flag", () => {
		const v = decideDesktopAccess(
			{ ...expired, firstLaunchMs: NOW - 2 * DAY },
			BETA_ON
		);
		expect(v.reason).toBe("beta");
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("still honours a real subscription under the beta flag (keeps managed inference)", () => {
		const v = decideDesktopAccess(
			{ ...expired, liveEntitlement: sub },
			BETA_ON
		);
		expect(v.reason).toBe("subscription");
		expect(v.managedInference).toBe(true);
	});
});

describe("CAPABILITY_TIERS — free local features and paid managed services", () => {
	it("does not plan-gate local desktop power features", () => {
		for (const capability of [
			"prompt-studio",
			"evals",
			"graphrag",
			"companion-overlay",
			"gateway-governance-ui",
		] as const) {
			expect(GATED_CAPABILITIES).not.toContain(capability);
		}
	});

	it("does not plan-gate Marketplace app and plugin surfaces", () => {
		for (const capability of [
			"council",
			"local-background-runs",
			"fine-tuning",
			"clips",
		] as const) {
			expect(GATED_CAPABILITIES).not.toContain(capability);
		}
	});

	it("keeps cloud capabilities in the subscription band", () => {
		for (const cap of [
			"managed-inference",
			"cloud-sync",
			"cloud-node",
			"hosted-bots",
			"team-seats",
			"agent-mail",
		] as const) {
			expect(capabilityTier(cap)).toBe("subscription");
		}
	});
});

describe("planLimit — numeric caps (free baseline vs paid rows)", () => {
	it("returns the free baseline for a null plan", () => {
		expect(planLimit(null, "maxOpenTabs")).toBe(3);
		expect(planLimit(null, "maxAgents")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxSpaces")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxConcurrentRuns")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxEvalRunsMonthly")).toBe(
			Number.POSITIVE_INFINITY
		);
		expect(planLimit(null, "spaceStorageLimitGb")).toBe(1);
		expect(planLimit(null, "maxRemoteNodes")).toBe(1);
	});

	it("mirrors FREE_TIER_LIMITS exactly for a null plan (single source)", () => {
		for (const field of Object.keys(FREE_TIER_LIMITS).filter(
			(key): key is PlanLimitField => Object.hasOwn(QUOTAS, key)
		)) {
			expect(planLimit(null, field)).toBe(FREE_TIER_LIMITS[field]);
		}
	});

	it("gives paid rows unbounded symbolic caps", () => {
		for (const plan of [
			"desktop-license",
			"pro",
			"plus",
			"max",
			"teams",
			"teams-lite",
			"business",
		] as const) {
			expect(planLimit(plan, "maxAgents")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxRemoteNodes")).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("keeps hosted storage finite per plan", () => {
		expect(planLimit("desktop-license", "spaceStorageLimitGb")).toBe(20);
		expect(planLimit("pro", "spaceStorageLimitGb")).toBe(10);
		expect(planLimit("plus", "spaceStorageLimitGb")).toBe(10);
		expect(planLimit("max", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("teams", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("teams-lite", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("business", "spaceStorageLimitGb")).toBe(50);
		// A Major Pass adds no hosted storage: it keeps the free baseline rather
		// than falling through to an unbounded default.
		expect(planLimit("marketplace-membership", "spaceStorageLimitGb")).toBe(
			planLimit(null, "spaceStorageLimitGb")
		);
		for (const plan of PLAN_IDS) {
			expect(Number.isFinite(planLimit(plan, "spaceStorageLimitGb"))).toBe(
				true
			);
		}
	});

	/**
	 * The whole tier × key matrix, written out. The registry derives every paid
	 * row from {@link QuotaSpec.paid} defaulting to unbounded, so a mistyped
	 * `paid` map is a REPRICING that no per-key assertion above would catch — this
	 * is the guard that moving a key between registries never moves a number.
	 */
	it("pins every tier × quota number", () => {
		const INF = Number.POSITIVE_INFINITY;
		const matrix = {
			maxAgents: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxConcurrentRuns: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxEvalRunsMonthly: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxOpenTabs: [3, INF, INF, INF, INF, INF, INF, INF],
			maxRemoteNodes: [1, INF, INF, INF, INF, INF, INF, INF],
			maxSpaces: [INF, INF, INF, INF, INF, INF, INF, INF],
			spaceStorageLimitGb: [1, 20, 10, 10, 50, 50, 50, 50],
		} satisfies Record<
			PlanLimitField,
			[
				free: number,
				license: number,
				pro: number,
				plus: number,
				max: number,
				teams: number,
				teamsLite: number,
				business: number,
			]
		>;
		// Every declared key is in the matrix, and vice versa: a new quota that
		// forgot its numbers fails here rather than shipping a silent Infinity.
		expect(Object.keys(matrix).sort()).toEqual(Object.keys(QUOTAS).sort());
		for (const [
			field,
			[free, license, pro, plus, max, teams, teamsLite, business],
		] of Object.entries(matrix)) {
			const quotaField = Object.keys(QUOTAS).find(
				(key): key is PlanLimitField => key === field
			);
			if (!quotaField) {
				throw new Error("Missing quota fixture");
			}
			expect(planLimit(null, quotaField)).toBe(free);
			expect(planLimit("desktop-license", quotaField)).toBe(license);
			expect(planLimit("pro", quotaField)).toBe(pro);
			expect(planLimit("plus", quotaField)).toBe(plus);
			expect(planLimit("max", quotaField)).toBe(max);
			expect(planLimit("teams", quotaField)).toBe(teams);
			expect(planLimit("teams-lite", quotaField)).toBe(teamsLite);
			expect(planLimit("business", quotaField)).toBe(business);
		}
	});
});

describe("quota ownership — Core-owned limits", () => {
	it("leaves shell and Core-subsystem quotas unowned", () => {
		for (const field of [
			"maxOpenTabs",
			"maxRemoteNodes",
			"maxSpaces",
			"maxAgents",
			"maxConcurrentRuns",
			"maxEvalRunsMonthly",
			"spaceStorageLimitGb",
		] as const) {
			expect(quotaOwner(field)).toBeNull();
			expect(KERNEL_QUOTAS).toHaveProperty(field);
		}
	});

	it("does not expose Marketplace app/plugin quota keys", () => {
		for (const field of [
			"maxMcpServers",
			"maxMonitors",
			"maxPlugins",
			"maxSchedules",
			"maxSkills",
			"maxWorkflows",
			"meetingRetentionDays",
		] as const) {
			expect(QUOTAS).not.toHaveProperty(field);
		}
	});

	it("carries a label and a unit on every key, so surfaces need no table", () => {
		for (const spec of Object.values(QUOTAS)) {
			expect(spec.label.trim().length).toBeGreaterThan(0);
			expect(["count", "days", "gigabytes"]).toContain(spec.unit);
		}
		expect(QUOTAS.spaceStorageLimitGb.unit).toBe("gigabytes");
	});

	it("keeps every remaining quota Core-owned", () => {
		for (const field of Object.keys(QUOTAS).filter(
			(key): key is PlanLimitField => Object.hasOwn(QUOTAS, key)
		)) {
			expect(quotaOwner(field)).toBeNull();
		}
	});
});

describe("Lifetime (desktop-license) bands into the pro capability tier", () => {
	const defaults = (): undefined => undefined;

	it("resolves a live desktop license to pro-unlocked, no managed inference", () => {
		const e = resolveEntitlement(null, { active: true }, defaults);
		expect(e.plan).toBe("desktop-license");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(false);
	});

	it("unlocks pro features (proUnlocked) for a desktop license", () => {
		const NOW = 1_000_000_000_000;
		const DAY = 24 * 60 * 60 * 1000;
		const licenseEnt: Entitlement = {
			plan: "desktop-license",
			desktopAccess: true,
			marketplaceApps: false,
			managedInference: false,
			monthlyCreditPoolMicroUsd: 0,
			seats: 1,
		};
		const v = decideDesktopAccess({
			firstLaunchMs: NOW - 30 * DAY, // trial long over
			liveEntitlement: licenseEnt,
			licenseActive: false,
			cached: null,
			nowMs: NOW,
		});
		// Band 2 (pro) unlocks; Band 3 (managed inference) stays off.
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
	});
});

describe("managedInferenceAvailable — balance gate, not a pure tier gate", () => {
	const license: Entitlement = {
		plan: "desktop-license",
		desktopAccess: true,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const proSub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(19.5),
		seats: 1,
	};
	const none: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};

	it("lets a Lifetime license spend once it has a PAYG balance (no included pool)", () => {
		expect(managedInferenceAvailable(license, 0)).toBe(false);
		expect(managedInferenceAvailable(license, usdToMicro(5))).toBe(true);
	});

	it("lets a subscription with an included pool spend at zero balance", () => {
		expect(managedInferenceAvailable(proSub, 0)).toBe(true);
	});

	it("opens standalone PAYG only when the wallet has prepaid balance", () => {
		expect(managedInferenceAvailable(none, 0)).toBe(false);
		expect(managedInferenceAvailable(none, -1)).toBe(false);
		expect(managedInferenceAvailable(none, usdToMicro(5))).toBe(true);
	});
});

describe("resolveInboxLifecycle — subscription-lapse policy", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = 1_800_000_000_000;

	it("is active with cleared anchors while the owner is entitled", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: true,
			lapsedAtMs: NOW - 10 * DAY,
			deactivatedAtMs: NOW - 5 * DAY,
			nowMs: NOW,
		});
		expect(v.state).toBe("active");
		expect(v.lapsedAtMs).toBeNull();
		expect(v.deactivatedAtMs).toBeNull();
		expect(v.acceptsInbound).toBe(true);
		expect(v.agentReadOnly).toBe(false);
		expect(v.eligibleForDeletionAtMs).toBeNull();
	});

	it("enters grace at first observation of a lapse (anchors now)", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs: null,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("grace");
		expect(v.lapsedAtMs).toBe(NOW);
		expect(v.acceptsInbound).toBe(true); // inbound still stored in grace
		expect(v.agentReadOnly).toBe(true); // agent access paused
	});

	it("stays in grace until graceDays elapse, still accepting inbound", () => {
		const lapsedAtMs = NOW - (MAIL_LIFECYCLE.graceDays - 1) * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("grace");
		expect(v.lapsedAtMs).toBe(lapsedAtMs);
		expect(v.acceptsInbound).toBe(true);
		expect(v.deactivatedAtMs).toBeNull();
	});

	it("deactivates once grace expires: inbound rejected, mail retained", () => {
		const lapsedAtMs = NOW - (MAIL_LIFECYCLE.graceDays + 1) * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("deactivated");
		expect(v.acceptsInbound).toBe(false);
		expect(v.agentReadOnly).toBe(true);
		// Deactivation anchors at grace end; deletion eligible retentionDays later.
		const graceEnd = lapsedAtMs + MAIL_LIFECYCLE.graceDays * DAY;
		expect(v.deactivatedAtMs).toBe(graceEnd);
		expect(v.eligibleForDeletionAtMs).toBe(
			graceEnd + MAIL_LIFECYCLE.retentionDays * DAY
		);
	});

	it("keeps a stored deactivation anchor stable (retention window doesn't slide)", () => {
		const deactivatedAtMs = NOW - 10 * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs: NOW - (MAIL_LIFECYCLE.graceDays + 20) * DAY,
			deactivatedAtMs,
			nowMs: NOW,
		});
		expect(v.state).toBe("deactivated");
		expect(v.deactivatedAtMs).toBe(deactivatedAtMs);
		expect(v.eligibleForDeletionAtMs).toBe(
			deactivatedAtMs + MAIL_LIFECYCLE.retentionDays * DAY
		);
	});

	it("restores to active on re-upgrade within retention (anchors cleared)", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: true, // owner re-subscribed
			lapsedAtMs: NOW - (MAIL_LIFECYCLE.graceDays + 5) * DAY,
			deactivatedAtMs: NOW - 5 * DAY,
			nowMs: NOW,
		});
		expect(v.state).toBe("active");
		expect(v.lapsedAtMs).toBeNull();
		expect(v.deactivatedAtMs).toBeNull();
		expect(v.acceptsInbound).toBe(true);
		expect(v.agentReadOnly).toBe(false);
	});
});

describe("updatesWindowEndMs — the lifetime updates window", () => {
	const FIRST_BUY = Date.UTC(2026, 0, 1);
	const MID_WINDOW_BUY = Date.UTC(2026, 6, 1);

	it("returns null when there are no orders", () => {
		expect(updatesWindowEndMs([])).toBeNull();
	});

	it("adds one calendar year to a single purchase", () => {
		expect(updatesWindowEndMs([FIRST_BUY])).toBe(Date.UTC(2027, 0, 1));
	});

	it("stacks a second purchase made while the window is still open", () => {
		// Six months left + a re-buy = eighteen months, not a re-anchored twelve.
		expect(updatesWindowEndMs([FIRST_BUY, MID_WINDOW_BUY])).toBe(
			Date.UTC(2028, 0, 1)
		);
	});

	it("anchors to the purchase when the previous window already lapsed", () => {
		expect(updatesWindowEndMs([Date.UTC(2024, 0, 1), MID_WINDOW_BUY])).toBe(
			Date.UTC(2027, 6, 1)
		);
	});

	it("adds approved bonus years on top of the stacked window", () => {
		expect(updatesWindowEndMs([FIRST_BUY, MID_WINDOW_BUY], 2)).toBe(
			Date.UTC(2030, 0, 1)
		);
	});

	it("ignores a negative bonus-year count", () => {
		expect(updatesWindowEndMs([FIRST_BUY], -5)).toBe(Date.UTC(2027, 0, 1));
	});

	it("ignores a non-finite bonus-year count rather than minting a NaN date", () => {
		// A NaN here would become `new Date(NaN).toISOString()` upstream, which
		// THROWS — so the guard degrades to "no bonus", never to a broken window.
		expect(updatesWindowEndMs([FIRST_BUY], Number.NaN)).toBe(
			Date.UTC(2027, 0, 1)
		);
	});

	it("rolls a 29 February purchase forward to 1 March", () => {
		expect(updatesWindowEndMs([Date.UTC(2028, 1, 29)])).toBe(
			Date.UTC(2029, 2, 1)
		);
	});

	it("ignores non-finite order times", () => {
		expect(updatesWindowEndMs([Number.NaN, FIRST_BUY])).toBe(
			Date.UTC(2027, 0, 1)
		);
		expect(updatesWindowEndMs([Number.NaN])).toBeNull();
	});

	it("honours a swapped config rather than a hardcoded year", () => {
		expect(
			updatesWindowEndMs([FIRST_BUY], 0, {
				...UPDATES_WINDOW,
				yearsPerPurchase: 2,
			})
		).toBe(Date.UTC(2028, 0, 1));
	});
});

describe("updatesCutoffMs + updatesWindowApplies", () => {
	const WINDOW_END = Date.UTC(2027, 0, 1);

	it("adds the skew grace exactly once", () => {
		expect(updatesCutoffMs(WINDOW_END)).toBe(
			WINDOW_END + UPDATES_WINDOW.skewGraceMs
		);
		expect(
			updatesCutoffMs(WINDOW_END, { ...UPDATES_WINDOW, skewGraceMs: 0 })
		).toBe(WINDOW_END);
	});

	it("applies the window to a desktop-license holder", () => {
		expect(updatesWindowApplies("desktop-license")).toBe(true);
	});

	it("does not apply the window to a subscriber or to no plan", () => {
		// A lifetime owner who later subscribes resolves to the SUBSCRIPTION plan,
		// and an actively-paying user must never be pinned to old builds.
		for (const plan of ["pro", "max", "teams", null] as const) {
			expect(updatesWindowApplies(plan)).toBe(false);
		}
	});
});

describe("decideUpdateEligibility — which builds a lifetime owner may install", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const WINDOW_END = Date.UTC(2027, 0, 1);
	const CUTOFF = updatesCutoffMs(WINDOW_END);
	const base = {
		cutoffMs: CUTOFF,
		nowMs: WINDOW_END - DAY,
		releasePublishedAtMs: WINDOW_END - DAY,
	};

	it("is unrestricted when no window applies", () => {
		const v = decideUpdateEligibility({ ...base, cutoffMs: null });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("no-window");
		expect(v.windowLapsed).toBe(false);
	});

	it("allows a release published inside the window", () => {
		const v = decideUpdateEligibility(base);
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
		expect(v.windowLapsed).toBe(false);
	});

	it("allows a release published after the window when the date is unknown", () => {
		const v = decideUpdateEligibility({
			...base,
			nowMs: CUTOFF + DAY,
			releasePublishedAtMs: null,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("unknown-release-date");
		expect(v.windowLapsed).toBe(true);
	});

	it("withholds a release published after the cutoff", () => {
		const v = decideUpdateEligibility({
			...base,
			nowMs: CUTOFF + 10 * DAY,
			releasePublishedAtMs: CUTOFF + DAY,
		});
		expect(v.eligible).toBe(false);
		expect(v.reason).toBe("outside-window");
		expect(v.windowLapsed).toBe(true);
	});

	it("allows a release published exactly at the cutoff", () => {
		const v = decideUpdateEligibility({
			...base,
			releasePublishedAtMs: CUTOFF,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
	});

	it("reports windowLapsed without withholding a release from inside the window", () => {
		// The case that must keep working: a lapsed owner still receives EVERY
		// build their window covers — the lapse only drives the renew prompt.
		const v = decideUpdateEligibility({ ...base, nowMs: CUTOFF + 10 * DAY });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
		expect(v.windowLapsed).toBe(true);
	});

	it("fails open on a NaN publish timestamp", () => {
		const v = decideUpdateEligibility({
			...base,
			releasePublishedAtMs: Number.NaN,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("unknown-release-date");
	});

	it("fails open on a NaN cutoff", () => {
		const v = decideUpdateEligibility({ ...base, cutoffMs: Number.NaN });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("no-window");
		expect(v.windowLapsed).toBe(false);
	});
});

describe("gatewayRateCeilingForEntitlement", () => {
	const managed = (plan: Entitlement["plan"], seats = 1): Entitlement => ({
		desktopAccess: true,
		managedInference: true,
		marketplaceApps: false,
		monthlyCreditPoolMicroUsd: 0,
		plan,
		seats,
	});

	it("gives free, promo, and unreadable entitlements the lowest ceiling", () => {
		const unmanaged = gatewayRateCeilingForEntitlement(null);
		expect(
			gatewayRateCeilingForEntitlement({
				...managed(null),
				managedInference: false,
			})
		).toEqual(unmanaged);
		expect(
			gatewayRateCeilingForEntitlement(managed("max")).rpm
		).toBeGreaterThan(unmanaged.rpm);
	});

	it("scales organization plans by seats and keeps personal plans flat", () => {
		const teamsOne = gatewayRateCeilingForEntitlement(managed("teams", 1));
		const teamsTen = gatewayRateCeilingForEntitlement(managed("teams", 10));
		expect(teamsTen.rpm).toBe(teamsOne.rpm * 10);
		expect(gatewayRateCeilingForEntitlement(managed("pro", 10))).toEqual(
			gatewayRateCeilingForEntitlement(managed("pro", 1))
		);
	});
});

describe("canRemovePoweredByRyu", () => {
	it("keeps the badge for free, trial and one-time plans", () => {
		expect(canRemovePoweredByRyu(null)).toBe(false);
		expect(canRemovePoweredByRyu("desktop-license")).toBe(false);
		expect(canRemovePoweredByRyu("marketplace-membership")).toBe(false);
		expect(canRemovePoweredByRyu("pro")).toBe(true);
	});

	// Core decides the badge for app sidecars from the `managed-inference-entitled`
	// flag the desktop already pushes (`apps/core/src/entitlement.rs`). That is
	// only sound while the two capabilities cover the same plans; a plan that
	// splits them must give Core its own branding signal first.
	it("branding removal tracks managed inference", () => {
		for (const id of PLAN_IDS) {
			expect({ id, removable: canRemovePoweredByRyu(id) }).toEqual({
				id,
				removable: PLANS[id].managedInference,
			});
		}
	});
});
