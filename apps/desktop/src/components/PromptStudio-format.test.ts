import { describe, expect, test } from "bun:test";

import { pctRange } from "./PromptStudio-format.ts";

describe("pctRange", () => {
	test("writes a score bucket the way the locale writes ranges", () => {
		expect(pctRange(0, 0.25, "en")).toBe(
			new Intl.NumberFormat("en", { style: "percent" }).formatRange(0, 0.25)
		);
		expect(pctRange(0.75, 1, "de")).toContain("%");
		expect(pctRange(0.75, 1, "de")).toBe(
			new Intl.NumberFormat("de", { style: "percent" }).formatRange(0.75, 1)
		);
	});
});
