import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditBalanceBreakdown } from "./credit-balance-breakdown.tsx";

describe("CreditBalanceBreakdown", () => {
	it("shows total, separate buckets, and each free-provider allocation", () => {
		const html = renderToStaticMarkup(
			<CreditBalanceBreakdown
				onDemandCreditsMicroUsd={20_000_000}
				planAllowanceMicroUsd={15_000_000}
				planCreditsMicroUsd={7_500_000}
				providerAllocations={[
					{
						expiresAtLabel: "Expires Sep 30, 2026",
						id: "fast",
						isFreeProvider: true,
						label: "Ryu Fast",
						remainingMicroUsd: 4_250_000,
					},
					{
						id: "frontier",
						isFreeProvider: false,
						label: "Ryu Frontier",
						remainingMicroUsd: 10_000_000,
					},
				]}
				totalMicroUsd={41_750_000}
			/>
		);

		for (const value of [
			"$41.75",
			"Free-provider credits",
			"Plan credits",
			"On-demand credits",
			"$4.25",
			"Ryu Fast",
			"Expires Sep 30, 2026",
			"Allocated free provider only",
			"Other provider-specific allocations",
		]) {
			expect(html).toContain(value);
		}
		expect(html).toContain('aria-label="About plan credits"');
		expect(html).not.toContain("41750000");
	});

	it("keeps a depleted plan bucket at zero instead of falling back to its allowance", () => {
		const html = renderToStaticMarkup(
			<CreditBalanceBreakdown
				onDemandCreditsMicroUsd={0}
				planAllowanceMicroUsd={15_000_000}
				planCreditsMicroUsd={0}
				providerAllocations={[]}
				totalMicroUsd={0}
			/>
		);

		expect(html).toContain("$0.00 left of $15.00 this billing period");
		expect(html).toContain("No free-provider credits are currently allocated.");
	});

	it("does not hide a negative total when metering has created an overdraft", () => {
		const html = renderToStaticMarkup(
			<CreditBalanceBreakdown
				onDemandCreditsMicroUsd={-80_000}
				planCreditsMicroUsd={0}
				providerAllocations={[]}
				totalMicroUsd={-80_000}
			/>
		);

		expect(html.match(/-\$0\.08/g)?.length).toBe(2);
	});

	it("renders Polar's aggregate balance without inventing local buckets", () => {
		const html = renderToStaticMarkup(
			<CreditBalanceBreakdown
				balanceBreakdownAvailable={false}
				onDemandCreditsMicroUsd={null}
				planCreditsMicroUsd={null}
				providerAllocations={[
					{
						id: "cloudflare",
						isFreeProvider: true,
						label: "Ryu Fast",
						remainingMicroUsd: 2_500_000,
					},
				]}
				totalMicroUsd={12_500_000}
			/>
		);

		expect(html).toContain("Polar balance");
		expect(html).toContain("$12.50");
		expect(html).toContain("Polar maintains this aggregate credit meter");
		expect(html).toContain("Provider-specific allocations");
		expect(html).toContain("Ryu Fast");
		expect(html).toContain("$2.50");
		expect(html).not.toContain("Plan credits");
		expect(html).not.toContain("On-demand credits");
	});
});
