import { describe, expect, test } from "bun:test";
import { appTierFromWire, isCoreAppTier } from "./plugins.ts";

describe("plugin provenance", () => {
	test("only Core-derived tier is first-party", () => {
		expect(isCoreAppTier("core")).toBe(true);
		expect(isCoreAppTier("community")).toBe(false);
		expect(isCoreAppTier(null)).toBe(false);
		expect(isCoreAppTier(undefined)).toBe(false);
	});

	test("a claimed @ryu namespace does not affect the decision", () => {
		const app = { id: "@ryu/security-center", tier: "community" as const };
		expect(isCoreAppTier(app.tier)).toBe(false);
	});

	test("unknown wire provenance fails closed", () => {
		expect(appTierFromWire("core")).toBe("core");
		expect(appTierFromWire("community")).toBe("community");
		expect(appTierFromWire("@ryu/")).toBeNull();
		expect(appTierFromWire(undefined)).toBeNull();
	});
});
