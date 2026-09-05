import { describe, expect, it } from "bun:test";
import {
	ORGANIZATION_FEATURES,
	organizationFeatureByKey,
	resolveOrganizationFeature,
} from "./organization-features.ts";

describe("organization feature controls", () => {
	it("keeps the customer catalog separate and key-validated", () => {
		expect(ORGANIZATION_FEATURES.length).toBeGreaterThan(0);
		expect(organizationFeatureByKey("apps.marketplace")?.group).toBe(
			"Apps and marketplace"
		);
		expect(
			organizationFeatureByKey("billing.individual_plans")
		).toBeUndefined();
	});

	it("resolves member overrides before organization defaults", () => {
		const feature = ORGANIZATION_FEATURES[0];
		expect(feature).toBeDefined();
		if (!feature) {
			return;
		}

		expect(resolveOrganizationFeature(feature)).toBe(true);
		expect(resolveOrganizationFeature(feature, false)).toBe(false);
		expect(resolveOrganizationFeature(feature, false, true)).toBe(true);
		expect(resolveOrganizationFeature(feature, true, false)).toBe(false);
	});

	it("labels the boundary that makes each control authoritative", () => {
		expect(organizationFeatureByKey("products.box")?.enforcement).toBe("api");
		expect(organizationFeatureByKey("apps.install")?.enforcement).toBe("ui");
	});
});
