import { describe, expect, it } from "bun:test";
import { POLICY_DENY_ALL } from "@ryu/db/models/control-plane.model";
import {
	featureAllowedByPolicy,
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

	it("layers team overrides between the organization and the member", () => {
		const feature = ORGANIZATION_FEATURES[0];
		if (!feature) {
			throw new Error("catalog is empty");
		}
		expect(resolveOrganizationFeature(feature, true, null, [false])).toBe(
			false
		);
		expect(resolveOrganizationFeature(feature, false, null, [true])).toBe(true);
		// The member override still wins over every team.
		expect(resolveOrganizationFeature(feature, false, true, [false])).toBe(
			true
		);
		// Across several teams, any team turning it off wins.
		expect(resolveOrganizationFeature(feature, true, null, [true, false])).toBe(
			false
		);
		expect(resolveOrganizationFeature(feature, false, null, [null])).toBe(
			false
		);
	});

	it("gates every toggle with the policy's allowedFeatures globs", () => {
		expect(featureAllowedByPolicy("apps.install", [])).toBe(true);
		expect(featureAllowedByPolicy("apps.install", ["apps.*"])).toBe(true);
		expect(featureAllowedByPolicy("APPS.install", ["apps.install"])).toBe(true);
		expect(featureAllowedByPolicy("engines.update", ["apps.*"])).toBe(false);
	});

	it("turns every feature off under a deny-all allowedFeatures", () => {
		for (const feature of ORGANIZATION_FEATURES) {
			expect(featureAllowedByPolicy(feature.key, [POLICY_DENY_ALL])).toBe(
				false
			);
		}
	});

	it("labels the boundary that makes each control authoritative", () => {
		expect(organizationFeatureByKey("products.box")?.enforcement).toBe("api");
		expect(organizationFeatureByKey("apps.install")?.enforcement).toBe("api");
		expect(organizationFeatureByKey("engines.catalog")?.enforcement).toBe("ui");
	});

	it("ships hosted Messaging off until an admin enables it", () => {
		// Leasing numbers and sending messages spends organization credit, so
		// the control is opt-in (like Managed Agents) and enforced by the API.
		const feature = organizationFeatureByKey("products.messaging");
		expect(feature?.defaultEnabled).toBe(false);
		expect(feature?.enforcement).toBe("api");
		expect(feature?.group).toBe("Products");
		expect(feature && resolveOrganizationFeature(feature)).toBe(false);
	});

	it("lets admins disable desktop egress routing, which Core enforces", () => {
		const feature = organizationFeatureByKey("network.local_egress");
		expect(feature?.enforcement).toBe("api");
		expect(feature?.defaultEnabled).toBe(true);
		expect(feature?.group).toBe("Network");
	});
});
