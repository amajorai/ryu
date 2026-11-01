import { describe, expect, test } from "bun:test";
import { offerLifetimeAccess } from "./nav-user-plan.ts";

describe("offerLifetimeAccess", () => {
	test("offers Lifetime to a non-owner when individual plans are on and upsells show", () => {
		expect(
			offerLifetimeAccess({
				individualPlansEnabled: true,
				isLifetime: false,
				showUpsell: true,
			})
		).toBe(true);
	});

	test("hides Lifetime while the billing.individual_plans rollout is off", () => {
		expect(
			offerLifetimeAccess({
				individualPlansEnabled: false,
				isLifetime: false,
				showUpsell: true,
			})
		).toBe(false);
	});

	test("hides Lifetime during beta and from someone who already owns it", () => {
		expect(
			offerLifetimeAccess({
				individualPlansEnabled: true,
				isLifetime: false,
				showUpsell: false,
			})
		).toBe(false);
		expect(
			offerLifetimeAccess({
				individualPlansEnabled: true,
				isLifetime: true,
				showUpsell: true,
			})
		).toBe(false);
	});
});
