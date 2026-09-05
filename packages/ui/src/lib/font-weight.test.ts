import { describe, expect, test } from "bun:test";
import { fontWeights } from "./font-weight.ts";

describe("font weights", () => {
	test("keeps legacy emphasis names at the medium interface weight", () => {
		expect(fontWeights.semibold).toBe(fontWeights.medium);
		expect(fontWeights.bold).toBe(fontWeights.medium);
	});
});
