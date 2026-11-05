import { describe, expect, test } from "bun:test";
import { formatUptime } from "./status-uptime-format.ts";

describe("formatUptime", () => {
	test("uses the locale's decimal separator", () => {
		expect(formatUptime(0.9987, "en")).toBe("99.87");
		expect(formatUptime(0.9987, "de")).toBe("99,87");
	});

	test("uses the locale's digits", () => {
		const arabic = formatUptime(0.9987, "ar-EG");
		expect(arabic).not.toMatch(/[0-9]/u);
		expect(arabic).toContain("٩٩");
	});

	test("a full share reads 100 with no decimals", () => {
		expect(formatUptime(1, "en")).toBe("100");
		expect(formatUptime(1, "de")).toBe("100");
	});

	test("truncates instead of rounding up to 100", () => {
		expect(formatUptime(0.999_96, "en")).toBe("99.99");
		expect(formatUptime(28 / 30, "de")).toBe("93,33");
	});
});
