import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	currentPlanVersionFor,
	monthlyCreditPoolMicroUsdForSeats,
	PLANS,
	type PlanId,
	planVersionFor,
	SERVICE_RATES,
} from "@ryu/auth/lib/plans";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AGENT_STEP_MODEL,
	agentStepCostUsd,
	approximateCount,
	COMPOSIO_MANAGED_TOOL_CALL_MICRO_USD,
	planCreditEstimates,
	SMALL_BOX,
	smallBoxHourUsd,
} from "./pricing-credit-estimates.ts";
import { PricingCreditEstimatesSection } from "./pricing-credit-estimates-section.tsx";

const repoRoot = new URL("../../../../", import.meta.url);
const readRepoFile = (path: string): string =>
	readFileSync(new URL(path, repoRoot), "utf8");
const MICRO_USD_PER_USD = 1_000_000;

/** The catalog's current monthly pool for `plan` at `seats` billed seats. */
function catalogPoolUsd(plan: PlanId, seats: number): number {
	return (
		monthlyCreditPoolMicroUsdForSeats({
			plan: PLANS[plan],
			seats,
			version: planVersionFor(plan, currentPlanVersionFor(plan)),
		}) / MICRO_USD_PER_USD
	);
}

describe("what your credits buy", () => {
	it("prices the public plans from the catalog's current pools", () => {
		const pools = Object.fromEntries(
			planCreditEstimates().map((plan) => [plan.id, plan.poolUsd])
		);
		expect(pools).toEqual({
			pro: catalogPoolUsd("pro", 1),
			max: catalogPoolUsd("max", 1),
			teams: catalogPoolUsd("teams", 5),
			business: catalogPoolUsd("business", 5),
		});
		// Business grants per FULL five seats; Teams per started bundle.
		expect(catalogPoolUsd("business", 9)).toBe(pools.business ?? 0);
		expect(catalogPoolUsd("teams", 6)).toBe((pools.teams ?? 0) * 2);
	});

	it("uses the live small-Box rate and the managed Composio tool-call rate", () => {
		const { boxSmallSeconds } = SERVICE_RATES.box.meters;
		expect(smallBoxHourUsd()).toBeCloseTo(
			(boxSmallSeconds.microUsd * 3600) /
				boxSmallSeconds.perUnits /
				MICRO_USD_PER_USD,
			10
		);
		// The small size the billing adapter meters.
		expect(
			readRepoFile("packages/api/src/lib/service-usage-adapters.ts")
		).toMatch(
			new RegExp(
				`small: \\{ memoryGib: ${SMALL_BOX.memoryGib}, [^}]*vcpu: ${SMALL_BOX.vcpu} \\}`,
				"u"
			)
		);
		const composio = JSON.parse(
			readRepoFile("crates/gateway/contracts/fixtures/composio-rates.json")
		) as { base: { toolCall: { managedApp: number } } };
		expect(COMPOSIO_MANAGED_TOOL_CALL_MICRO_USD).toBe(
			composio.base.toolCall.managedApp
		);
	});

	it("derives every figure by dividing the pool by the unit cost", () => {
		expect(agentStepCostUsd()).toBeCloseTo(0.001_542, 9);
		for (const plan of planCreditEstimates()) {
			expect(plan.agentSteps).toBe(
				Math.floor(plan.poolUsd / agentStepCostUsd())
			);
			expect(plan.boxHours).toBe(Math.floor(plan.poolUsd / smallBoxHourUsd()));
			expect(plan.toolCalls).toBe(
				Math.floor(
					(plan.poolUsd * MICRO_USD_PER_USD) /
						COMPOSIO_MANAGED_TOOL_CALL_MICRO_USD
				)
			);
		}
	});

	it("rounds counts down for approximate copy", () => {
		expect(approximateCount(9727.6)).toBe("9,700");
		expect(approximateCount(69.6)).toBe("69");
		expect(approximateCount(200_000)).toBe("200,000");
		expect(approximateCount(0)).toBe("0");
	});

	it("renders labelled values, one estimate note, and no private plan names", () => {
		const html = renderToStaticMarkup(<PricingCreditEstimatesSection />);
		expect(html).toContain("What your credits buy");
		expect(html).toContain(AGENT_STEP_MODEL.name);
		for (const plan of planCreditEstimates()) {
			expect(html).toContain(`~${approximateCount(plan.agentSteps)} steps`);
			expect(html).toContain(`~${approximateCount(plan.boxHours)} hours`);
			expect(html).toContain(`~${approximateCount(plan.toolCalls)} calls`);
		}
		expect(html.match(/These are estimates/gu)).toHaveLength(1);
		expect(html).toContain("Credits are shared across all your usage");
		expect(html).not.toMatch(/\bPlus\b|Teams Lite/u);
	});

	it("matches the estimate table in the public credits docs", () => {
		const doc = readRepoFile(
			"apps/fumadocs/content/docs/billing/credits.mdx"
		).replaceAll(/\s+/gu, " ");
		for (const plan of planCreditEstimates()) {
			expect(doc).toContain(
				`| ~${approximateCount(plan.agentSteps)} | ~${approximateCount(plan.boxHours)} | ~${approximateCount(plan.toolCalls)} |`
			);
		}
		expect(doc).toContain(`$${smallBoxHourUsd().toFixed(4)} an hour`);
		expect(doc).toContain(`about $${agentStepCostUsd().toFixed(4)} a step`);
	});
});
