import { describe, expect, test } from "bun:test";

import { hasStageHero, isStageProductSlug } from "./stage-routes.ts";

describe("stage hero routes", () => {
	test("product pages open on a stage", () => {
		expect(hasStageHero("/products/core")).toBe(true);
		expect(hasStageHero("/products/red-team/")).toBe(true);
	});

	test("bot and agent keep the stage at their top-level aliases", () => {
		expect(hasStageHero("/bot")).toBe(true);
		expect(hasStageHero("/agent")).toBe(true);
	});

	test("marketing pages open on a stage", () => {
		expect(hasStageHero("/enterprise")).toBe(true);
		expect(hasStageHero("/pro/")).toBe(true);
		expect(hasStageHero("/products")).toBe(true);
		expect(hasStageHero("/pricing")).toBe(false);
		expect(hasStageHero("/marketplace")).toBe(false);
	});

	test("other routes keep the regular header", () => {
		expect(hasStageHero("/")).toBe(false);
		expect(hasStageHero("/core")).toBe(false);
		expect(hasStageHero("/products/unknown")).toBe(false);
		expect(hasStageHero("/products/core/extra")).toBe(false);
	});

	test("slug guard", () => {
		expect(isStageProductSlug("gateway")).toBe(true);
		expect(isStageProductSlug("pricing")).toBe(false);
	});
});
