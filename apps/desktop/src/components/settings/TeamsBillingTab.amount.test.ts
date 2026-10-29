import { describe, expect, it } from "bun:test";
import { planMonthlyAmount } from "./TeamsBillingTab.tsx";

describe("Teams billing plan amounts come from the catalog", () => {
	it("prices every recurring plan instead of showing $0", () => {
		expect(planMonthlyAmount("plus")).toBe("$39.00/mo");
		expect(planMonthlyAmount("pro")).toBe("$49.00/mo");
		expect(planMonthlyAmount("max")).toBe("$99.00/mo");
		expect(planMonthlyAmount("marketplace-membership")).toBe("$20.00/mo");
		expect(planMonthlyAmount("teams-lite")).toBe("$150.00/mo minimum");
		expect(planMonthlyAmount("teams")).toBe("$250.00/mo minimum");
		expect(planMonthlyAmount("business")).toBe("$300.00/mo minimum");
		expect(planMonthlyAmount("desktop-license")).toBe("Paid once");
		expect(planMonthlyAmount(null)).toBe("$0/mo");
	});

	it("scales organization plans with billed seats", () => {
		expect(planMonthlyAmount("teams", { seats: 5 })).toBe("$250.00/mo");
		expect(planMonthlyAmount("teams", { seats: 7 })).toBe("$350.00/mo");
		expect(planMonthlyAmount("teams-lite", { seats: 6 })).toBe("$200.00/mo");
		expect(planMonthlyAmount("business", { seats: 6 })).toBe("$350.00/mo");
		expect(planMonthlyAmount("business", { seats: 80 })).toBe(
			"Contract pricing"
		);
	});

	it("shows the grandfathered price for a stamped plan version", () => {
		expect(planMonthlyAmount("pro", { planVersion: 5 })).toBe("$39.00/mo");
		expect(
			planMonthlyAmount("marketplace-membership", { planVersion: "2" })
		).toBe("$9.99/mo");
		expect(planMonthlyAmount("pro", { planVersion: 99 })).toBe("$49.00/mo");
	});

	it("treats seat counts above self-serve as contracted on every plan", () => {
		expect(planMonthlyAmount("teams", { seats: 50 })).toBe("$2,500.00/mo");
		expect(planMonthlyAmount("teams", { seats: 51 })).toBe("Contract pricing");
	});

	it("names no figure for retired rows one catalog row cannot price", () => {
		expect(planMonthlyAmount("teams", { planVersion: 4, seats: 5 })).toBe(
			"Contract pricing"
		);
		expect(planMonthlyAmount("pro", { planVersion: 2 })).toBe(
			"Contract pricing"
		);
		expect(planMonthlyAmount("max", { planVersion: 1 })).toBe("$99.00/mo");
	});
});
