import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STARTUP_REALM,
	resolveProductMode,
	resolveStartupRealm,
} from "./product-mode.ts";

describe("desktop product surface", () => {
	test("keeps OS available without Console organization access", () => {
		expect(resolveProductMode("os", false, true)).toBe("os");
		expect(resolveProductMode("bot", false, true)).toBe("bot");
	});

	test("holds OS behind its rollout flag, opening Bot instead", () => {
		expect(resolveProductMode("os", true, false)).toBe("bot");
		expect(resolveProductMode("os", false, false)).toBe("bot");
		expect(resolveProductMode("console", true, false)).toBe("console");
	});

	test("fails a stale Console preference closed when access is denied", () => {
		expect(resolveProductMode("console", false, true)).toBe("bot");
		expect(resolveProductMode("console", true, true)).toBe("console");
	});

	test("defaults new users to Bot through the last-used startup realm", () => {
		expect(DEFAULT_STARTUP_REALM).toBe("last-used");
		expect(resolveStartupRealm(DEFAULT_STARTUP_REALM, "bot")).toBe("bot");
	});

	test("restores the last used realm or an explicit startup choice", () => {
		expect(resolveStartupRealm("last-used", "console")).toBe("console");
		expect(resolveStartupRealm("os", "console")).toBe("os");
	});
});
