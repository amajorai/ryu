import { expect, test } from "bun:test";
import { formatRatingAverage } from "./rating-average.ts";

test("rating averages keep one decimal in the locale's form", () => {
	expect(formatRatingAverage(4.46, "en")).toBe("4.5");
	expect(formatRatingAverage(4, "en")).toBe("4.0");
	expect(formatRatingAverage(4.46, "de")).toBe("4,5");
	expect(formatRatingAverage(undefined, "fr")).toBe("0,0");
});
