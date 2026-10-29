import { z } from "zod";
import { usdToMicro } from "./plans.ts";

/** Live organization plans for hosted business automation. */
export const HOSTED_AGENT_PLAN_IDS = ["teams", "pro", "max"] as const;
export type HostedAgentPlanId = (typeof HOSTED_AGENT_PLAN_IDS)[number];

/**
 * Names used by the first hosted-agent rollout. They remain readable so a
 * renewal can be normalized into the current Pro/Max contract without losing
 * an organization's allowance during a rolling deploy. They are not public
 * checkout ids and must not be added back to the pricing catalog.
 */
export const LEGACY_HOSTED_AGENT_PLAN_IDS = [
	"business-agents",
	"enterprise-agents",
] as const;
export type LegacyHostedAgentPlanId =
	(typeof LEGACY_HOSTED_AGENT_PLAN_IDS)[number];

/** The capacity profile a plan recommends; it is not the billing boundary. */
export type HostedAgentNodeProfile =
	| "pooled-standard"
	| "dedicated-performance";

/** One incremental-agent price band. `toAgent` is inclusive. */
export interface HostedAgentVolumeTier {
	readonly fromAgent: number;
	readonly packSize: number;
	readonly pricePerAgentMicroUsd: number;
	readonly toAgent: number;
}

/** Commercial configuration for a hosted automation plan. */
export interface HostedAgentPlan {
	/** Capacity changes are sold in fixed bundles rather than individual seats. */
	readonly agentBundleSize: number;
	readonly baseMonthlyPriceMicroUsd: number;
	readonly id: HostedAgentPlanId;
	readonly includedAgents: number;
	/** Shared monthly credit grant added for each additional paid agent. */
	readonly includedCreditPerAdditionalAgentMicroUsd: number;
	/** Monthly managed-inference credit grant at the plan's agent floor. */
	readonly includedCreditPoolMicroUsd: number;
	readonly localInferenceConfigurable: boolean;
	/** Hosted local-model execution is off by default on shared capacity. */
	readonly localInferenceDefault: boolean;
	/** Pro eligibility boundary; Max has no published member cap. */
	readonly maxOrganizationMembers?: number;
	readonly name: string;
	readonly nodeProfile: HostedAgentNodeProfile;
	readonly volumeTiers: readonly HostedAgentVolumeTier[];
}

/** Organizations above this size need an Enterprise commercial contract. */
export const HOSTED_AGENT_PRO_MAX_ORG_MEMBERS = 50;
/** Kept as a compatibility alias for callers from the first rollout. */
export const HOSTED_AGENT_BUSINESS_MAX_ORG_MEMBERS =
	HOSTED_AGENT_PRO_MAX_ORG_MEMBERS;
/** Public hosted-agent capacity changes are sold in five-agent bundles. */
export const HOSTED_AGENT_BUNDLE_SIZE = 5;
/** Hosted-agent pricing snapshot version; separate from legacy seat plans. */
export const HOSTED_AGENT_PRICING_VERSION = 5;

/**
 * Private founding conversation offer. This is deliberately not imported by
 * the public pricing tree: only a staff-issued Polar discount can activate it.
 * It is a paid proof period ($50/mo), not a free trial, and the subscription
 * returns to the public $250/mo five-seat Teams floor after three billing
 * periods. The field names remain agent-compatible for legacy webhook records.
 */
export const TEAMS_FOUNDING_TRIAL = {
	discountBasisPoints: 8000,
	durationMonths: 3,
	includedAgents: 5,
	listMonthlyPriceUsd: 250,
	trialMonthlyPriceUsd: 50,
} as const;

/**
 * Largest share of the amount ACTUALLY PAID for a discounted Teams period that
 * may be granted back as the organization's included credit pool.
 *
 * The list Teams pool ($50 per five billed seats) is sized against the list
 * price. An 80% promotional discount keeps the full pool and the included
 * `cx43` node while collecting a fifth of the revenue: at five seats that was
 * about -$41 a month (about -$168 a month at fifty seats).
 *
 * 20% rather than the 30% ceiling the margin review allowed: after Polar
 * processing and the OpenRouter funding fee plus GST, a 30% pool still leaves
 * the five-seat month about $1 under water once the `cx43` reserve is paid.
 * `discounted-offer-economics.test.ts` holds both offers to a non-negative
 * contribution for every discounted period.
 */
export const DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS = 2000;

/** What a percentage discount leaves the customer paying for one period. */
export function discountedPeriodPaidMicroUsd(input: {
	discountBasisPoints: number;
	listPriceMicroUsd: number;
}): number {
	const { discountBasisPoints, listPriceMicroUsd } = input;
	if (!(Number.isFinite(listPriceMicroUsd) && listPriceMicroUsd > 0)) {
		return 0;
	}
	const keptBasisPoints = Math.min(
		10_000,
		Math.max(0, 10_000 - discountBasisPoints)
	);
	// Round DOWN: the pool cap below is derived from this figure, so an
	// over-stated payment would over-grant.
	return Math.floor((listPriceMicroUsd * keptBasisPoints) / 10_000);
}

/**
 * The included pool for a period on which a promotional discount is active:
 * the list pool, capped at {@link DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS}
 * of what the customer actually paid for that period. Never negative.
 */
export function discountedPeriodPoolMicroUsd(input: {
	listPoolMicroUsd: number;
	paidMicroUsd: number;
}): number {
	const { listPoolMicroUsd, paidMicroUsd } = input;
	if (!(Number.isFinite(paidMicroUsd) && paidMicroUsd > 0)) {
		return 0;
	}
	if (!(Number.isFinite(listPoolMicroUsd) && listPoolMicroUsd > 0)) {
		return 0;
	}
	const cap = Math.floor(
		(paidMicroUsd * DISCOUNTED_TEAMS_PERIOD_POOL_SHARE_BASIS_POINTS) / 10_000
	);
	return Math.min(listPoolMicroUsd, cap);
}

/**
 * Legacy hosted automation catalog. Teams' current public commercial unit is
 * the Better Auth member seat in `plans.ts`; these agent fields remain only for
 * grandfathered/internal hosted-agent records.
 *
 * Teams starts with a five-agent process bundle. Pro and Max remain internal
 * legacy hosted contracts until the sales motion is repeatable.
 */
/** Each catalog entry exposes the commercial plan contract, including optional member caps. */
interface HostedAgentPlanCatalog {
	readonly max: HostedAgentPlan;
	readonly pro: HostedAgentPlan;
	readonly teams: HostedAgentPlan;
}
export const HOSTED_AGENT_PLANS: HostedAgentPlanCatalog = {
	teams: {
		agentBundleSize: HOSTED_AGENT_BUNDLE_SIZE,
		id: "teams",
		name: "Teams",
		baseMonthlyPriceMicroUsd: usdToMicro(250),
		includedAgents: 5,
		maxOrganizationMembers: HOSTED_AGENT_PRO_MAX_ORG_MEMBERS,
		volumeTiers: [
			{
				fromAgent: 6,
				toAgent: 10,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(50),
			},
			{
				fromAgent: 11,
				toAgent: Number.POSITIVE_INFINITY,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(40),
			},
		],
		includedCreditPoolMicroUsd: usdToMicro(50),
		includedCreditPerAdditionalAgentMicroUsd: usdToMicro(25),
		nodeProfile: "pooled-standard",
		localInferenceDefault: false,
		localInferenceConfigurable: true,
	},
	pro: {
		agentBundleSize: HOSTED_AGENT_BUNDLE_SIZE,
		id: "pro",
		name: "Pro Plan",
		baseMonthlyPriceMicroUsd: usdToMicro(250),
		includedAgents: 5,
		maxOrganizationMembers: HOSTED_AGENT_PRO_MAX_ORG_MEMBERS,
		volumeTiers: [
			{
				fromAgent: 6,
				toAgent: 10,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(50),
			},
			{
				fromAgent: 11,
				toAgent: Number.POSITIVE_INFINITY,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(40),
			},
		],
		includedCreditPoolMicroUsd: usdToMicro(50),
		includedCreditPerAdditionalAgentMicroUsd: usdToMicro(25),
		nodeProfile: "pooled-standard",
		localInferenceDefault: false,
		localInferenceConfigurable: true,
	},
	max: {
		agentBundleSize: HOSTED_AGENT_BUNDLE_SIZE,
		id: "max",
		name: "Max Plan",
		baseMonthlyPriceMicroUsd: usdToMicro(2500),
		includedAgents: 50,
		volumeTiers: [
			{
				fromAgent: 51,
				toAgent: 100,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(30),
			},
			{
				fromAgent: 101,
				toAgent: Number.POSITIVE_INFINITY,
				packSize: 5,
				pricePerAgentMicroUsd: usdToMicro(25),
			},
		],
		includedCreditPoolMicroUsd: usdToMicro(250),
		includedCreditPerAdditionalAgentMicroUsd: usdToMicro(5),
		nodeProfile: "dedicated-performance",
		localInferenceDefault: false,
		localInferenceConfigurable: true,
	},
};

/** Keep checkout and support quotes inside a bounded, reviewable range. */
export const MAX_HOSTED_AGENT_COUNT = 1000;

/** Parse a support bonus expiry from persisted or webhook metadata. */
export const hostedAgentBonusExpiry = z
	.union([
		z.date(),
		z
			.string()
			.trim()
			.min(1)
			.transform((value) => new Date(value))
			.pipe(z.date()),
	])
	.nullable()
	.catch(null).parse;

const hostedAgentPlan = (planId: HostedAgentPlanId): HostedAgentPlan =>
	HOSTED_AGENT_PLANS[planId];

/** Check the published organization-size boundary for a hosted plan. */
export const hostedAgentPlanAllowsOrganization = (input: {
	organizationMemberCount: number;
	planId: HostedAgentPlanId;
}): boolean => {
	const maxMembers = hostedAgentPlan(input.planId).maxOrganizationMembers;
	if (maxMembers === undefined) {
		return true;
	}
	const memberCount = Number.isFinite(input.organizationMemberCount)
		? Math.max(0, Math.floor(input.organizationMemberCount))
		: 0;
	return memberCount <= maxMembers;
};

const normalizedCount = (
	value: number,
	fallback: number,
	bundleSize: number
): number => {
	if (!Number.isFinite(value)) {
		return Math.max(fallback, bundleSize);
	}
	const bounded = Math.max(
		1,
		Math.min(MAX_HOSTED_AGENT_COUNT, Math.floor(value))
	);
	return Math.max(fallback, Math.ceil(bounded / bundleSize) * bundleSize);
};

/** Return the incremental tier in force for one agent, if any. */
export const hostedAgentTierFor = (
	planId: HostedAgentPlanId,
	agentNumber: number
): HostedAgentVolumeTier | null =>
	hostedAgentPlan(planId).volumeTiers.find(
		(tier) => agentNumber >= tier.fromAgent && agentNumber <= tier.toAgent
	) ?? null;

/**
 * Price a contracted allowance. The base price covers `includedAgents`; only
 * contracted agents above that floor are charged incrementally.
 */
export const hostedAgentMonthlyPriceMicroUsd = (
	planId: HostedAgentPlanId,
	contractedAgents: number
): number => {
	const plan = hostedAgentPlan(planId);
	const count = Math.max(
		plan.includedAgents,
		normalizedCount(contractedAgents, plan.includedAgents, plan.agentBundleSize)
	);
	let price = plan.baseMonthlyPriceMicroUsd;
	for (
		let agentNumber = plan.includedAgents + 1;
		agentNumber <= count;
		agentNumber++
	) {
		const tier = hostedAgentTierFor(planId, agentNumber);
		if (!tier) {
			throw new Error(`No hosted-agent price tier covers agent ${agentNumber}`);
		}
		price += tier.pricePerAgentMicroUsd;
	}
	return price;
};

/**
 * Calculate the shared monthly AI-credit grant for a paid contracted allowance.
 * Negotiated bonus agents are deliberately excluded by the caller: they add
 * capacity without silently increasing Ryu's recurring model-cost exposure.
 */
export const hostedAgentIncludedCreditPoolMicroUsd = (
	planId: HostedAgentPlanId,
	contractedAgents: number
): number => {
	const plan = hostedAgentPlan(planId);
	const count = Math.max(
		plan.includedAgents,
		normalizedCount(contractedAgents, plan.includedAgents, plan.agentBundleSize)
	);
	return (
		plan.includedCreditPoolMicroUsd +
		Math.max(0, count - plan.includedAgents) *
			plan.includedCreditPerAdditionalAgentMicroUsd
	);
};

/** The next capacity-bundle price at a given allowance, when a pack applies. */
export const hostedAgentPackPriceUsd = (
	planId: HostedAgentPlanId,
	agentNumber: number
): number | null => {
	const tier = hostedAgentTierFor(planId, agentNumber);
	return tier && tier.packSize > 1
		? (tier.pricePerAgentMicroUsd * tier.packSize) / 1_000_000
		: null;
};

export interface HostedAgentQuote {
	readonly bonusAgents: number;
	/** Agents covered by the paid contract before negotiated bonus capacity. */
	readonly contractedAgents: number;
	/** Effective org allowance, including any negotiated bonus agents. */
	readonly effectiveAgents: number;
	readonly includedCreditPoolMicroUsd: number;
	readonly monthlyPriceMicroUsd: number;
	readonly nodeProfile: HostedAgentNodeProfile;
	readonly planId: HostedAgentPlanId;
}

/** A hosted-agent quote with its org binding, suitable for the API response. */
export interface HostedAgentEntitlement extends HostedAgentQuote {
	readonly bonusExpiresAt: Date | null;
	readonly organizationId: string;
	readonly subscriptionId: string | null;
}

/**
 * Build the org entitlement used by checkout and support.
 *
 * `bonusAgents` is intentionally capacity only: it reduces the contracted
 * count used for pricing and credit-grant funding. The paid contracted count
 * grows the shared organization pool; a negotiated bonus does not.
 * Support can set an expiry on a bonus in the org record before renewal.
 */
export const quoteHostedAgentPlan = (input: {
	agentCount: number;
	bonusAgents?: number;
	/** Preserve a pre-bundle grandfathered allowance during migration. */
	allowLegacyBelowFloor?: boolean;
	planId: HostedAgentPlanId;
}): HostedAgentQuote => {
	const plan = hostedAgentPlan(input.planId);
	const rawRequestedAgents = Number.isFinite(input.agentCount)
		? Math.max(1, Math.floor(input.agentCount))
		: plan.includedAgents;
	const requestedBonus = Math.max(
		0,
		Number.isFinite(input.bonusAgents ?? 0)
			? Math.floor(input.bonusAgents ?? 0)
			: 0
	);
	const rawContractedAgents = Math.max(1, rawRequestedAgents - requestedBonus);
	const allowLegacyBelowFloor =
		input.allowLegacyBelowFloor === true &&
		rawContractedAgents < plan.includedAgents;
	const requestedAgents = allowLegacyBelowFloor
		? rawContractedAgents + requestedBonus
		: normalizedCount(
				rawRequestedAgents,
				plan.includedAgents,
				plan.agentBundleSize
			);
	const bonusAgents = allowLegacyBelowFloor
		? requestedBonus
		: Math.min(
				requestedBonus,
				Math.max(0, requestedAgents - plan.includedAgents)
			);
	const contractedAgents = Math.max(
		allowLegacyBelowFloor ? rawContractedAgents : plan.includedAgents,
		requestedAgents - bonusAgents
	);
	const pricingAgents = allowLegacyBelowFloor
		? plan.includedAgents
		: Math.max(plan.includedAgents, contractedAgents);

	return {
		planId: input.planId,
		contractedAgents,
		bonusAgents,
		effectiveAgents: contractedAgents + bonusAgents,
		monthlyPriceMicroUsd: hostedAgentMonthlyPriceMicroUsd(
			input.planId,
			pricingAgents
		),
		includedCreditPoolMicroUsd: hostedAgentIncludedCreditPoolMicroUsd(
			input.planId,
			pricingAgents
		),
		nodeProfile: plan.nodeProfile,
	};
};

/** Narrow untrusted plan ids before looking them up. */
const hostedPlanIdBoundarySchema = z.preprocess(
	(value) => value,
	z.enum(HOSTED_AGENT_PLAN_IDS)
);
export const isHostedAgentPlanId = (
	value: z.input<typeof hostedPlanIdBoundarySchema>
): value is HostedAgentPlanId =>
	hostedPlanIdBoundarySchema.safeParse(value).success;

/** Convert first-rollout ids to the current public Pro/Max ids. */
export const normalizeHostedAgentPlanId = z
	.union([
		z.enum(HOSTED_AGENT_PLAN_IDS),
		z.literal("business-agents").transform(() => "pro" as const),
		z.literal("enterprise-agents").transform(() => "max" as const),
	])
	.nullable()
	.catch(null).parse;

/** Restore a persisted entitlement from its org-level contract fields. */
export const hostedAgentEntitlementFromContract = (input: {
	bonusAgents?: number;
	contractedAgents: number;
	includedCreditPoolMicroUsd?: number;
	monthlyPriceMicroUsd?: number;
	planId: HostedAgentPlanId;
}): HostedAgentQuote => {
	const quote = {
		...quoteHostedAgentPlan({
			planId: input.planId,
			agentCount: input.contractedAgents + Math.max(0, input.bonusAgents ?? 0),
			bonusAgents: input.bonusAgents,
			allowLegacyBelowFloor: true,
		}),
	};
	if (input.includedCreditPoolMicroUsd !== undefined) {
		quote.includedCreditPoolMicroUsd = input.includedCreditPoolMicroUsd;
	}
	if (input.monthlyPriceMicroUsd !== undefined) {
		quote.monthlyPriceMicroUsd = input.monthlyPriceMicroUsd;
	}
	return quote;
};
