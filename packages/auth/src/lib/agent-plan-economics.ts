import {
	type HostedAgentPlanId,
	hostedAgentIncludedCreditPoolMicroUsd,
	hostedAgentMonthlyPriceMicroUsd,
} from "./agent-plans.ts";

/** Planning regions for the included managed-node reserve. */
export type HostedAgentCostRegion = "eu" | "sin";

/** Rounded cash-flow guard for one included node, before support labour. */
export const HOSTED_AGENT_NODE_RESERVE_USD = {
	teams: { eu: 12, sin: 44 },
	pro: { eu: 12, sin: 44 },
	max: { eu: 80, sin: 88 },
} satisfies Readonly<
	Record<HostedAgentPlanId, Readonly<Record<HostedAgentCostRegion, number>>>
>;

/** External cost assumptions used by the internal contribution model. */
export const HOSTED_AGENT_ECONOMIC_ASSUMPTIONS = {
	openRouterFundingMultiplier: 1.055,
	polarFixedUsd: 0.4,
	polarSubscriptionRate: 0.045,
} as const;

export interface HostedAgentContributionMargin {
	readonly contributionUsd: number;
	readonly includedPoolUsd: number;
	readonly margin: number;
	readonly monthlyPriceUsd: number;
	readonly nodeReserveUsd: number;
	readonly polarReserveUsd: number;
	readonly region: HostedAgentCostRegion;
}

/**
 * Calculate the recurring hosted-agent contribution floor for one organization.
 * This intentionally assumes the whole included pool is consumed and excludes
 * support/handholding, refunds, sales commission, and costs not represented by
 * the configured metering rates.
 */
export const hostedAgentContributionMargin = (
	planId: HostedAgentPlanId,
	contractedAgents: number,
	region: HostedAgentCostRegion = "eu"
): HostedAgentContributionMargin => {
	const monthlyPriceUsd =
		hostedAgentMonthlyPriceMicroUsd(planId, contractedAgents) / 1_000_000;
	const includedPoolUsd =
		hostedAgentIncludedCreditPoolMicroUsd(planId, contractedAgents) / 1_000_000;
	const nodeReserveUsd = HOSTED_AGENT_NODE_RESERVE_USD[planId][region];
	const polarReserveUsd =
		monthlyPriceUsd * HOSTED_AGENT_ECONOMIC_ASSUMPTIONS.polarSubscriptionRate +
		HOSTED_AGENT_ECONOMIC_ASSUMPTIONS.polarFixedUsd;
	const contributionUsd =
		monthlyPriceUsd -
		includedPoolUsd *
			HOSTED_AGENT_ECONOMIC_ASSUMPTIONS.openRouterFundingMultiplier -
		nodeReserveUsd -
		polarReserveUsd;
	return {
		contributionUsd,
		includedPoolUsd,
		margin: contributionUsd / monthlyPriceUsd,
		monthlyPriceUsd,
		nodeReserveUsd,
		polarReserveUsd,
		region,
	};
};
