import { describe, expect, it } from "bun:test";
import {
	CLOUD_NODE_CHANGE_PLAN_IDS,
	CLOUD_NODE_CHANGE_PLANS_LABEL,
	cloudNodeEntitlementFor,
	planAllowsCloudNodeChanges,
} from "./cloud-node-access.ts";

describe("managed-server plan access", () => {
	it("allows only the self-serve organization plans", () => {
		for (const plan of CLOUD_NODE_CHANGE_PLAN_IDS) {
			expect(planAllowsCloudNodeChanges(plan)).toBe(true);
		}
	});

	it("does not turn individual or non-managed plans into node buyers", () => {
		for (const plan of [
			"desktop-license",
			"marketplace-membership",
			"plus",
			"pro",
			"max",
		] as const) {
			expect(planAllowsCloudNodeChanges(plan)).toBe(false);
		}
		expect(planAllowsCloudNodeChanges(null)).toBe(false);
		expect(planAllowsCloudNodeChanges(undefined)).toBe(false);
	});

	it("keeps the Enterprise contract in customer-facing copy", () => {
		expect(CLOUD_NODE_CHANGE_PLANS_LABEL).toBe(
			"Business, Teams, or Enterprise"
		);
	});

	it("never names a private plan in customer-facing copy", () => {
		expect(CLOUD_NODE_CHANGE_PLANS_LABEL).not.toMatch(/\bPlus\b|Teams Lite/u);
		// The private plan still buys nodes; only its name stays out of the copy.
		expect(planAllowsCloudNodeChanges("teams-lite")).toBe(true);
	});

	it("allows an active Enterprise contract without inventing a catalog plan", () => {
		expect(
			cloudNodeEntitlementFor({ plan: null, enterpriseActive: true })
		).toEqual({
			canBuyAdditionalNodes: true,
			canUpgradeIncludedNode: true,
			enterprise: true,
			plan: null,
			seats: 1,
		});
	});

	it("keeps individual plans out even when a legacy cloud subscription exists", () => {
		expect(
			cloudNodeEntitlementFor({ plan: "max", enterpriseActive: false })
		).toMatchObject({
			canBuyAdditionalNodes: false,
			canUpgradeIncludedNode: false,
		});
	});

	it("normalizes unusable seat values for the included-node ladder", () => {
		expect(
			cloudNodeEntitlementFor({
				plan: "teams",
				enterpriseActive: false,
				seats: 49.9,
			})
		).toHaveProperty("seats", 49);
		expect(
			cloudNodeEntitlementFor({
				plan: "teams",
				enterpriseActive: false,
				seats: Number.NaN,
			})
		).toHaveProperty("seats", 1);
	});
});
