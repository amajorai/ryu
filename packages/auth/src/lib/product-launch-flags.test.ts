import { describe, expect, it } from "bun:test";
import {
	CATALOG_AGENTS_AS_A_SERVICE_FLAG,
	CATALOG_RED_TEAM_FLAG,
	CATALOG_WORKFLOWS_FLAG,
	closedStandaloneProductPages,
	featureFlagByKey,
	resolveFeatureFlags,
} from "./feature-flags.ts";
import {
	hiddenProductListings,
	LAUNCH_GATED_PRODUCT_SLUGS,
	PRODUCT_LAUNCH_FLAGS,
	productLaunched,
	productLaunchFlag,
	unlaunchedProducts,
} from "./product-launch-flags.ts";

describe("product launch flags", () => {
	it("maps each unreleased product to its own catalog flag", () => {
		expect(PRODUCT_LAUNCH_FLAGS).toEqual({
			"agents-as-a-service": "catalog.agents_as_a_service",
			"red-team": "catalog.red_team",
			workflows: "catalog.workflows",
		});
		expect(productLaunchFlag("workflows")).toBe(CATALOG_WORKFLOWS_FLAG);
		expect(productLaunchFlag("core")).toBeUndefined();
	});

	it("ships every launch flag dark, public and fail-closed", () => {
		for (const key of [
			CATALOG_WORKFLOWS_FLAG,
			CATALOG_AGENTS_AS_A_SERVICE_FLAG,
			CATALOG_RED_TEAM_FLAG,
		]) {
			// Public, so the anonymous marketing read (`/api/feature-flags/public`)
			// carries it and an admin can turn it on from the console.
			expect(featureFlagByKey(key)).toMatchObject({
				defaultValue: false,
				exposure: "public",
				failMode: "closed",
			});
		}
	});

	it("keeps unreleased products unlisted until their flag reads true", () => {
		expect(unlaunchedProducts(null).toSorted()).toEqual(
			[...LAUNCH_GATED_PRODUCT_SLUGS].toSorted()
		);
		expect(productLaunched("cloud", null)).toBe(true);
		const values = resolveFeatureFlags({
			overrides: { [CATALOG_RED_TEAM_FLAG]: true },
		});
		expect(productLaunched("red-team", values)).toBe(true);
		expect(productLaunched("workflows", values)).toBe(false);
		expect(unlaunchedProducts(values).toSorted()).toEqual([
			"agents-as-a-service",
			"workflows",
		]);
	});

	it("hides closed standalone pages and unlaunched products together", () => {
		const values = resolveFeatureFlags({
			overrides: { [CATALOG_WORKFLOWS_FLAG]: true },
		});
		expect(hiddenProductListings(values).toSorted()).toEqual(
			[
				...closedStandaloneProductPages(values),
				"agents-as-a-service",
				"red-team",
			].toSorted()
		);
		expect(hiddenProductListings(null)).toEqual(
			expect.arrayContaining(["workflows", "agents-as-a-service", "red-team"])
		);
	});
});
