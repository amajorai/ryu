import { describe, expect, it } from "bun:test";
import {
	channelUserLimitForEntitlement,
	currentPlanVersionFor,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLANS,
	type PolarBinding,
	planByProductId,
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
		expect(entitlement.monthlyCreditPoolMicroUsd).toBe(usdToMicro(9));
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
		// v1 (never sold to a subscriber) takes the same completed-bundle pool:
		// its old per-started-bundle $200 at six seats lost money.
		for (const seats of [6, 10]) {
			expect(
				monthlyCreditPoolMicroUsdForSeats({
					plan,
					seats,
					version: planVersionFor("business", 1),
				})
			).toBe(
				monthlyCreditPoolMicroUsdForSeats({ plan, seats, version: current })
			);
		}
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
