import { expect, test } from "bun:test";

const { formatPercent } = await import("./shared.tsx");

test("English keeps the one-decimal cache hit rate", () => {
	expect(formatPercent(0.125, "en")).toBe("12.5%");
	expect(formatPercent(1, "en")).toBe("100.0%");
});

test("German and Arabic use their own decimal and percent forms", () => {
	expect(formatPercent(0.125, "de")).toBe(
		new Intl.NumberFormat("de", {
			maximumFractionDigits: 1,
			minimumFractionDigits: 1,
			style: "percent",
		}).format(0.125)
	);
	expect(formatPercent(0.125, "de")).toContain("12,5");
	expect(formatPercent(0.125, "ar")).not.toContain("12.5%");
});
