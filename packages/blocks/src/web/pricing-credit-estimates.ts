import {
	BUSINESS_CREDIT_BUNDLE_SIZE,
	businessIncludedCreditUsd,
} from "./business-pricing.ts";
import { PUBLISHED_PRICING } from "./data/standalone-pricing.ts";
import {
	hostedAgentIncludedCreditUsd,
	MAX_INCLUDED_USD,
	PRO_INCLUDED_USD,
	TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE,
} from "./pricing.tsx";

/**
 * Rough "what your monthly credits buy" figures for the public pricing page.
 *
 * Every input is a published figure: the plan pools mirror the billing catalog
 * (`pricing-catalog-drift.test.ts`), the Box rate mirrors `SERVICE_RATES`
 * (`standalone-pricing.test.ts`), and the tool-call rate mirrors the Composio
 * rate fixture. `pricing-credit-estimates.test.ts` checks each against its
 * source. Only the reference model's prices below live here.
 */

/**
 * The reference model for an agent step, in USD per million tokens.
 *
 * Source: DeepSeek's published list prices for DeepSeek V4.1 Flash (input,
 * cache-hit input, and output), as recorded on 2026-10-19. Update these three
 * numbers together when the provider's price page changes.
 */
export const AGENT_STEP_MODEL = {
	name: "DeepSeek V4.1 Flash",
	inputUsdPerMillion: 0.15,
	cachedInputUsdPerMillion: 0.003,
	outputUsdPerMillion: 0.6,
} as const;

/** One typical agent step: 20k input tokens, 70% of them cached, 1k output. */
export const AGENT_STEP_TOKENS = {
	input: 20_000,
	cachedInputShare: 0.7,
	output: 1000,
} as const;

/** The small Box size the estimate prices: 2 vCPU and 4 GiB of memory. */
export const SMALL_BOX = { memoryGib: 4, vcpu: 2 } as const;

/**
 * Composio's managed-app tool-call rate in micro-USD, from
 * `crates/gateway/contracts/fixtures/composio-rates.json` (`base.toolCall.managedApp`).
 */
export const COMPOSIO_MANAGED_TOOL_CALL_MICRO_USD = 500;

const TOKENS_PER_MILLION = 1_000_000;
const MICRO_USD_PER_USD = 1_000_000;

/** The USD cost of one agent step on the reference model. */
export function agentStepCostUsd(): number {
	const cached = AGENT_STEP_TOKENS.input * AGENT_STEP_TOKENS.cachedInputShare;
	const uncached = AGENT_STEP_TOKENS.input - cached;
	return (
		(uncached * AGENT_STEP_MODEL.inputUsdPerMillion +
			cached * AGENT_STEP_MODEL.cachedInputUsdPerMillion +
			AGENT_STEP_TOKENS.output * AGENT_STEP_MODEL.outputUsdPerMillion) /
		TOKENS_PER_MILLION
	);
}

/** The USD cost of one running hour of a small Box at the live Box rate. */
export function smallBoxHourUsd(): number {
	return PUBLISHED_PRICING.box.smallHourUsd;
}

/** The USD cost of one managed-app Composio tool call. */
export function toolCallUsd(): number {
	return COMPOSIO_MANAGED_TOOL_CALL_MICRO_USD / MICRO_USD_PER_USD;
}

/** One public plan's monthly credit pool and what it roughly buys. */
export interface PlanCreditEstimate {
	agentSteps: number;
	boxHours: number;
	/** How the pool is granted, such as "a month" or "per 5 seats a month". */
	cadence: string;
	id: "pro" | "max" | "teams" | "business";
	name: string;
	poolUsd: number;
	toolCalls: number;
}

/** The public plans in shelf order, with the pool each one grants. */
export function publicPlanCreditPools(): Pick<
	PlanCreditEstimate,
	"cadence" | "id" | "name" | "poolUsd"
>[] {
	return [
		{ cadence: "a month", id: "pro", name: "Pro", poolUsd: PRO_INCLUDED_USD },
		{ cadence: "a month", id: "max", name: "Max", poolUsd: MAX_INCLUDED_USD },
		{
			cadence: `per ${TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE} seats a month`,
			id: "teams",
			name: "Teams",
			poolUsd: hostedAgentIncludedCreditUsd(
				"teams",
				TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE
			),
		},
		{
			cadence: `per full ${BUSINESS_CREDIT_BUNDLE_SIZE} seats a month`,
			id: "business",
			name: "Business",
			poolUsd: businessIncludedCreditUsd(BUSINESS_CREDIT_BUNDLE_SIZE),
		},
	];
}

/** Each public plan's pool divided by the unit cost of each kind of usage. */
export function planCreditEstimates(): PlanCreditEstimate[] {
	const step = agentStepCostUsd();
	const boxHour = smallBoxHourUsd();
	const toolCall = toolCallUsd();
	return publicPlanCreditPools().map((plan) => ({
		...plan,
		agentSteps: Math.floor(plan.poolUsd / step),
		boxHours: Math.floor(plan.poolUsd / boxHour),
		toolCalls: Math.floor(plan.poolUsd / toolCall),
	}));
}

const countFormat = new Intl.NumberFormat("en-US");

/**
 * A rounded-down count for "about" copy: whole numbers below 100, otherwise
 * two significant figures ("9,727" becomes "9,700").
 */
export function approximateCount(value: number): string {
	if (!(Number.isFinite(value) && value > 0)) {
		return "0";
	}
	if (value < 100) {
		return countFormat.format(Math.floor(value));
	}
	const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
	return countFormat.format(Math.floor(value / magnitude) * magnitude);
}
