import { describe, expect, test } from "bun:test";
import { secretStatusLabel } from "./PluginSettingsFields-secret-field.tsx";

describe("secretStatusLabel", () => {
	test("a stored key with no write time reads as configured, not the set verb", () => {
		expect(secretStatusLabel({ key: "API_KEY", set: true })).toBe("Configured");
	});

	test("a missing key reads as not set", () => {
		expect(secretStatusLabel(null)).toBe("Not set");
		expect(secretStatusLabel({ key: "API_KEY", set: false })).toBe("Not set");
	});
});
