import { describe, expect, it } from "bun:test";
import {
	isIslandPlacement,
	parsePlacementArg,
	placementArg,
	placementForZone,
	zoneForPlacement,
} from "./placement.ts";

describe("placementForZone", () => {
	it("aligns away from the edges a zone docks to", () => {
		expect(placementForZone(0)).toEqual({ h: "start", v: "start" });
		expect(placementForZone(1)).toEqual({ h: "center", v: "start" });
		expect(placementForZone(4)).toEqual({ h: "center", v: "center" });
		expect(placementForZone(8)).toEqual({ h: "end", v: "end" });
		expect(placementForZone(6)).toEqual({ h: "start", v: "end" });
	});

	it("round-trips through zoneForPlacement for all nine zones", () => {
		for (let zone = 0; zone < 9; zone += 1) {
			expect(zoneForPlacement(placementForZone(zone))).toBe(zone);
		}
	});

	it("clamps out-of-range zones", () => {
		expect(placementForZone(-3)).toEqual(placementForZone(0));
		expect(placementForZone(42)).toEqual(placementForZone(8));
	});
});

describe("placement switch", () => {
	const fallback = placementForZone(8);

	it("round-trips through the command-line switch", () => {
		const placement = placementForZone(3);
		expect(
			parsePlacementArg(["electron", placementArg(placement)], fallback)
		).toEqual(placement);
	});

	it("falls back when the switch is missing or malformed", () => {
		expect(parsePlacementArg(["electron"], fallback)).toBe(fallback);
		expect(parsePlacementArg(["--island-placement=left,up"], fallback)).toBe(
			fallback
		);
	});

	it("guards untrusted values", () => {
		expect(isIslandPlacement({ h: "end", v: "start" })).toBe(true);
		expect(isIslandPlacement({ h: "end" })).toBe(false);
		expect(isIslandPlacement(null)).toBe(false);
	});
});
