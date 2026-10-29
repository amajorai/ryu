import { describe, expect, it } from "bun:test";
import {
	cellKey,
	DEFAULT_CELL,
	DEFAULT_VARIANT,
	PLAN_CAPACITIES,
	PLAN_PROVIDERS,
	PLAN_REGIONS,
	PROVISIONABLE_PROVIDERS,
	parseCellKey,
	regionForLocation,
	representativeLocationForRegion,
	variantKey,
} from "./plan-variants.ts";

describe("plan variants", () => {
	it("round-trips every cell key", () => {
		for (const provider of PLAN_PROVIDERS) {
			for (const capacity of PLAN_CAPACITIES) {
				for (const region of PLAN_REGIONS) {
					const cell = { capacity, provider, region };
					expect(parseCellKey(cellKey(cell))).toEqual(cell);
				}
			}
		}
		expect(cellKey(DEFAULT_CELL)).toBe("hetzner:standard:eu");
		expect(variantKey(DEFAULT_VARIANT)).toBe("hetzner:standard");
	});

	it("rejects anything that is not a known triple", () => {
		for (const raw of [
			null,
			undefined,
			42,
			"",
			"hetzner",
			"hetzner:standard",
			"hetzner:performance:eu",
			"aws:standard:eu",
			"hetzner:standard:us",
			"hetzner:standard:eu:extra",
		]) {
			expect(parseCellKey(raw)).toBeNull();
		}
		expect(parseCellKey(" Hetzner:Standard:SIN ")).toEqual({
			capacity: "standard",
			provider: "hetzner",
			region: "sin",
		});
	});

	it("has exactly one capacity: every plan has one base server", () => {
		// A stock-dependent capacity would bill customers for something they did
		// not choose (founder decision, 2026-10-19).
		expect(PLAN_CAPACITIES).toEqual(["standard"]);
	});

	it("can only provision on Hetzner today", () => {
		expect(PROVISIONABLE_PROVIDERS).toEqual(["hetzner"]);
	});

	it("maps provider locations to pricing regions", () => {
		expect(regionForLocation("sin")).toBe("sin");
		expect(regionForLocation(" SIN ")).toBe("sin");
		for (const location of ["nbg1", "fsn1", "hel1", "", null, undefined]) {
			expect(regionForLocation(location)).toBe("eu");
		}
		for (const region of PLAN_REGIONS) {
			expect(regionForLocation(representativeLocationForRegion(region))).toBe(
				region
			);
		}
	});
});
