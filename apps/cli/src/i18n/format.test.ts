import { describe, expect, test } from "bun:test";

import { formatCliBytes } from "./format.ts";

const GIB = 1024 ** 3;

describe("formatCliBytes", () => {
	test("keeps the English reading in English", () => {
		expect(formatCliBytes(1.5 * GIB, undefined, "en")).toBe("1.5 GB");
		expect(formatCliBytes(512, undefined, "en-GB")).toBe("512 B");
	});

	// ICU joins the number and unit with a plain or no-break space per unit.
	test("uses the locale's decimal separator", () => {
		expect(formatCliBytes(1.5 * GIB, undefined, "de")).toMatch(/^1,5\s+GB$/u);
		expect(
			formatCliBytes(
				2.25 * GIB,
				{ fractionDigits: 1, maxUnit: "gigabyte", minUnit: "gigabyte" },
				"de-AT"
			)
		).toMatch(/^2,3\s+GB$/u);
	});

	test("formats Japanese and Arabic sizes", () => {
		expect(formatCliBytes(1.5 * GIB, undefined, "ja")).toMatch(/^1\.5\s*GB$/u);
		const arabic = formatCliBytes(1.5 * GIB, undefined, "ar");
		expect(arabic).toContain(
			new Intl.NumberFormat("ar", { minimumFractionDigits: 1 }).format(1.5)
		);
		expect(arabic).not.toBe("1.5 GB");
	});
});
