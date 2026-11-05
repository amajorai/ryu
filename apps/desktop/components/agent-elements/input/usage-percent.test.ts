import { describe, expect, test } from "bun:test";

import { usagePercentText } from "./usage-percent.ts";

describe("usagePercentText", () => {
	test("rounds to a whole percentage in English", () => {
		expect(usagePercentText(41.6, "en")).toBe("42%");
		expect(usagePercentText(0, "en")).toBe("0%");
	});

	test("uses the locale's spacing and digits", () => {
		expect(usagePercentText(42, "de")).toBe(`42${String.fromCodePoint(0xa0)}%`);
		const arabic = usagePercentText(42, "ar");
		expect(arabic).toBe(
			new Intl.NumberFormat("ar", { style: "percent" }).format(0.42)
		);
		expect(arabic).not.toBe("42%");
	});
});
