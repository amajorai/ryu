import { describe, expect, it } from "bun:test";
import { chartColorVariableName, safeChartColor } from "./chart-safety.ts";

describe("chart CSS boundaries", () => {
	it("normalizes series keys before using them as CSS variable names", () => {
		expect(
			chartColorVariableName("orders;}</style><script>alert(1)</script>")
		).toBe("--color-orders-style-script-alert-1-script");
	});

	it("accepts chart colors and rejects declaration injection", () => {
		expect(safeChartColor("oklch(0.62 0.19 256)")).toBe("oklch(0.62 0.19 256)");
		expect(safeChartColor("#3987e5")).toBe("#3987e5");
		expect(
			safeChartColor("red; background: url(https://attacker.test)")
		).toBeNull();
		expect(safeChartColor("url(https://attacker.test)")).toBeNull();
	});

	it("accepts bare theme-token references and rejects anything else in var()", () => {
		expect(safeChartColor("var(--color-profile-chart-7)")).toBe(
			"var(--color-profile-chart-7)"
		);
		expect(safeChartColor("var(--a, url(https://attacker.test))")).toBeNull();
		expect(safeChartColor("var(--a); color: red")).toBeNull();
		expect(safeChartColor("var(color)")).toBeNull();
	});
});
