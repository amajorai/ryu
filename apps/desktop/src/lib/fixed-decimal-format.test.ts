import { expect, test } from "bun:test";
import { formatFixedDecimals } from "./fixed-decimal-format.ts";

test("a value keeps exactly the requested decimals in the locale's format", () => {
	expect(formatFixedDecimals(0.8731, 3, "en")).toBe("0.873");
	expect(formatFixedDecimals(0.5, 3, "de")).toBe("0,500");
	expect(formatFixedDecimals(0.35, 2, "fr")).toBe("0,35");
	expect(formatFixedDecimals(1, 2, "en")).toBe("1.00");
});
