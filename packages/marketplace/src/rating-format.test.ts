import { describe, expect, test } from "bun:test";
import { formatRatingAverage } from "./rating-format.ts";

describe("formatRatingAverage", () => {
	test("uses the locale's decimal separator with one fraction digit", () => {
		expect(formatRatingAverage(4.5, "en")).toBe("4.5");
		expect(formatRatingAverage(4.5, "de")).toBe("4,5");
		expect(formatRatingAverage(4, "fr")).toBe("4,0");
	});

	test("rounds to one decimal and treats a missing average as zero", () => {
		expect(formatRatingAverage(4.26, "en")).toBe("4.3");
		expect(formatRatingAverage(null, "de")).toBe("0,0");
		expect(formatRatingAverage(Number.NaN, "en")).toBe("0.0");
	});
});
