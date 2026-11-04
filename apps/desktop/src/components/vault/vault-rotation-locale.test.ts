import { describe, expect, test } from "bun:test";
import { rotationDaysText, rotationSecsFromDays } from "./vault-view.ts";

// The Vault "Rotate every (days)" field reads and shows days in the UI locale.
describe("vault rotation days by locale", () => {
	test("a German comma decimal is read as days", () => {
		expect(rotationSecsFromDays("1,5", "de")).toBe(129_600);
		expect(rotationSecsFromDays("30", "de")).toBe(2_592_000);
	});

	test("a saved fractional period prefills with the locale decimal", () => {
		expect(rotationDaysText(129_600, "de")).toBe("1,5");
		expect(rotationDaysText(129_600, "en")).toBe("1.5");
		expect(rotationDaysText(86_400 * 30, "de")).toBe("30");
	});

	test("unreadable or non-positive days are still refused", () => {
		expect(() => rotationSecsFromDays("abc", "de")).toThrow();
		expect(() => rotationSecsFromDays("0", "de")).toThrow();
	});
});
