import { describe, expect, it } from "bun:test";
import {
	HOSTED_AGENT_BUSINESS_MAX_ORG_MEMBERS,
	HOSTED_AGENT_PLANS,
	HOSTED_AGENT_PRICING_VERSION,
	hostedAgentEntitlementFromContract,
	hostedAgentIncludedCreditPoolMicroUsd,
	hostedAgentMonthlyPriceMicroUsd,
	hostedAgentPackPriceUsd,
	hostedAgentPlanAllowsOrganization,
	quoteHostedAgentPlan,
	TEAMS_FOUNDING_TRIAL,
} from "./agent-plans.ts";

const usd = (value: number): number => value * 1_000_000;

describe("hosted agent plans", () => {
	it("keeps organization size separate from process capacity", () => {
		expect(HOSTED_AGENT_PLANS.pro.maxOrganizationMembers).toBe(
			HOSTED_AGENT_BUSINESS_MAX_ORG_MEMBERS
		);
		expect(HOSTED_AGENT_PLANS.max.maxOrganizationMembers).toBeUndefined();
		expect(
			hostedAgentPlanAllowsOrganization({
				organizationMemberCount: 50,
				planId: "pro",
			})
		).toBe(true);
		expect(
			hostedAgentPlanAllowsOrganization({
				organizationMemberCount: 51,
				planId: "pro",
			})
		).toBe(false);
		expect(
			hostedAgentPlanAllowsOrganization({
				organizationMemberCount: 51,
				planId: "max",
			})
		).toBe(true);
	});

	it("keeps Pro at the $250 anchor for the five-agent floor", () => {
		expect(HOSTED_AGENT_PLANS.pro.includedAgents).toBe(5);
		expect(hostedAgentMonthlyPriceMicroUsd("pro", 5)).toBe(usd(250));
		expect(
			quoteHostedAgentPlan({ agentCount: 5, planId: "pro" })
		).toMatchObject({
			contractedAgents: 5,
			effectiveAgents: 5,
		});
	});

	it("keeps the private founding voucher on the real five-agent Pro contract", () => {
		expect(HOSTED_AGENT_PRICING_VERSION).toBe(5);
		expect(TEAMS_FOUNDING_TRIAL).toMatchObject({
			discountBasisPoints: 8000,
			durationMonths: 3,
			includedAgents: 5,
			listMonthlyPriceUsd: 250,
			trialMonthlyPriceUsd: 50,
		});
	});

	it("charges five-agent bundles through ten, then the discounted rate", () => {
		expect(hostedAgentMonthlyPriceMicroUsd("pro", 10)).toBe(usd(500));
		expect(hostedAgentMonthlyPriceMicroUsd("pro", 15)).toBe(usd(700));
		expect(hostedAgentMonthlyPriceMicroUsd("pro", 20)).toBe(usd(900));
		expect(hostedAgentPackPriceUsd("pro", 6)).toBe(250);
		expect(hostedAgentPackPriceUsd("pro", 11)).toBe(200);
	});

	it("keeps Max fixed at $2,500 for fifty and discounts larger packs", () => {
		expect(hostedAgentMonthlyPriceMicroUsd("max", 50)).toBe(usd(2500));
		expect(hostedAgentMonthlyPriceMicroUsd("max", 60)).toBe(usd(2800));
		expect(hostedAgentMonthlyPriceMicroUsd("max", 110)).toBe(usd(4250));
		expect(hostedAgentPackPriceUsd("max", 51)).toBe(150);
	});

	it("scales the shared pool with paid Pro agents", () => {
		expect(hostedAgentIncludedCreditPoolMicroUsd("pro", 5)).toBe(usd(50));
		expect(hostedAgentIncludedCreditPoolMicroUsd("pro", 10)).toBe(usd(175));
		expect(hostedAgentIncludedCreditPoolMicroUsd("pro", 20)).toBe(usd(425));
	});

	it("scales the shared pool with paid Max agents", () => {
		expect(hostedAgentIncludedCreditPoolMicroUsd("max", 50)).toBe(usd(250));
		expect(hostedAgentIncludedCreditPoolMicroUsd("max", 60)).toBe(usd(300));
		expect(hostedAgentIncludedCreditPoolMicroUsd("max", 110)).toBe(usd(550));
	});

	it("keeps negotiated bonus agents capacity-only", () => {
		const quote = quoteHostedAgentPlan({
			agentCount: 6,
			bonusAgents: 5,
			allowLegacyBelowFloor: true,
			planId: "pro",
		});

		expect(quote.contractedAgents).toBe(1);
		expect(quote.bonusAgents).toBe(5);
		expect(quote.effectiveAgents).toBe(6);
		expect(quote.monthlyPriceMicroUsd).toBe(usd(250));
		expect(quote.includedCreditPoolMicroUsd).toBe(usd(50));
	});

	it("restores a persisted contract using the same pricing rules", () => {
		const entitlement = hostedAgentEntitlementFromContract({
			bonusAgents: 15,
			contractedAgents: 1,
			planId: "pro",
		});

		expect(entitlement.effectiveAgents).toBe(16);
		expect(entitlement.monthlyPriceMicroUsd).toBe(usd(250));
	});
});
