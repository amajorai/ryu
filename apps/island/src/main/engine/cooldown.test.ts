import { describe, expect, it } from "bun:test";
import { AppCooldown, appKeyOf } from "./cooldown.ts";

describe("appKeyOf", () => {
	it("lowercases and defaults null to unknown", () => {
		expect(appKeyOf("Code")).toBe("code");
		expect(appKeyOf(null)).toBe("unknown");
	});
});

describe("AppCooldown", () => {
	it("cools down for the base window after arming", () => {
		const cooldown = new AppCooldown(1000, 5000);
		cooldown.arm("code", 0);
		expect(cooldown.isCoolingDown("code", 500)).toBe(true);
		expect(cooldown.isCoolingDown("code", 1500)).toBe(false);
	});

	it("does not cool down apps that were never armed", () => {
		const cooldown = new AppCooldown(1000, 5000);
		expect(cooldown.isCoolingDown("slack", 0)).toBe(false);
	});

	it("extends the window further on snooze than on dismiss", () => {
		const cooldown = new AppCooldown(1000, 5000);
		cooldown.penalize("code", "snooze", 0);
		expect(cooldown.isCoolingDown("code", 4000)).toBe(true);
		const other = new AppCooldown(1000, 5000);
		other.penalize("slack", "dismiss", 0);
		expect(other.isCoolingDown("slack", 1500)).toBe(false);
	});

	it("clears all cooldowns", () => {
		const cooldown = new AppCooldown(1000, 5000);
		cooldown.arm("code", 0);
		cooldown.clear();
		expect(cooldown.isCoolingDown("code", 100)).toBe(false);
	});
});
