import { describe, expect, it } from "bun:test";
import {
	isOrgFeatureEnabled,
	parseOrgFeatures,
	UNMANAGED_ORG_FEATURES,
} from "./org-features.ts";

describe("org features", () => {
	it("leaves every feature on for unmanaged nodes and malformed payloads", () => {
		expect(isOrgFeatureEnabled(UNMANAGED_ORG_FEATURES, "apps.install")).toBe(
			true
		);
		expect(parseOrgFeatures("nope")).toEqual(UNMANAGED_ORG_FEATURES);
	});

	it("honors organization toggles and fails closed when policy is unknown", () => {
		const managed = parseOrgFeatures({
			available: true,
			features: { "apps.install": false },
			managed: true,
		});
		expect(isOrgFeatureEnabled(managed, "apps.install")).toBe(false);
		expect(isOrgFeatureEnabled(managed, "engines.update")).toBe(true);

		const unknown = parseOrgFeatures({
			available: false,
			features: {},
			managed: true,
		});
		expect(isOrgFeatureEnabled(unknown, "engines.update")).toBe(false);
	});
});
