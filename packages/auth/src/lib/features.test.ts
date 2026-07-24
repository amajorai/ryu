import { describe, expect, it } from "bun:test";
import { FEATURES, featureByKey, hasFeature } from "./features.ts";

describe("FEATURES catalog invariants", () => {
	it("has no duplicate keys", () => {
		const keys = FEATURES.map((f) => f.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("never point-gates a default feature (spec §9 guardrail)", () => {
		for (const feature of FEATURES) {
			if (feature.tier === "default") {
				expect(feature.pointsCost).toBeUndefined();
				expect(feature.autoUnlockAtLevel).toBeUndefined();
			}
		}
	});

	it("gives every progressive feature a positive points cost", () => {
		for (const feature of FEATURES) {
			if (feature.tier === "progressive") {
				expect(feature.pointsCost).toBeGreaterThan(0);
			}
		}
	});

	it("gives every paid feature a non-empty requiresPlan list", () => {
		for (const feature of FEATURES) {
			if (feature.tier === "paid") {
				expect(feature.requiresPlan?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});
});

describe("featureByKey", () => {
	it("resolves a known key to its definition", () => {
		expect(featureByKey("chat")?.tier).toBe("default");
		expect(featureByKey("island")?.tier).toBe("progressive");
		expect(featureByKey("managed_inference")?.tier).toBe("paid");
	});

	it("returns undefined for an unknown key", () => {
		expect(featureByKey("does_not_exist")).toBeUndefined();
	});
});

describe("hasFeature (no-DB branches)", () => {
	it("grants any default-tier feature without touching the DB", async () => {
		expect(await hasFeature("user-1", "chat")).toBe(true);
		expect(await hasFeature("user-1", "sidebar")).toBe(true);
		expect(await hasFeature("user-1", "command_palette")).toBe(true);
	});

	it("denies an unknown key without touching the DB", async () => {
		expect(await hasFeature("user-1", "totally_made_up")).toBe(false);
	});
});
