import { createHash } from "node:crypto";
import { type GrandfatheringDecision, rowOf } from "./plan-grandfathering.ts";
import {
	type BillingInterval,
	bindingFor,
	type PlanId,
	type PlanVersion,
	resolveProductId,
} from "./plans.ts";

/**
 * Hashes over commercial terms. SERVER-ONLY (node:crypto): an armed migration
 * pins these, and a change to the target row's terms, its products or the
 * decision itself pauses the campaign instead of letting it move customers onto
 * terms nobody reviewed.
 */

const sha256 = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fields that make up what a customer pays and receives on a row. */
export const termsHash = (row: PlanVersion): string =>
	sha256({
		additionalSeatPriceMicroUsd: row.additionalSeatPriceMicroUsd ?? null,
		baseMonthlyPriceMicroUsd: row.baseMonthlyPriceMicroUsd ?? null,
		creditPoolBundleSize: row.creditPoolBundleSize ?? null,
		creditPoolModel: row.creditPoolModel ?? null,
		monthlyCreditPoolMicroUsd: row.monthlyCreditPoolMicroUsd,
		monthlyPriceMicroUsd: row.monthlyPriceMicroUsd,
		seatPriceTiers: row.seatPriceTiers ?? null,
	});

const RECURRING_INTERVALS: readonly BillingInterval[] = ["monthly", "yearly"];

/** The resolved product ids a row sells on, per recurring interval. */
export const rowProductIds = (
	plan: PlanId,
	row: PlanVersion,
	read: (key: string) => string | undefined = (k) => process.env[k]
): Partial<Record<BillingInterval, string>> => {
	const out: Partial<Record<BillingInterval, string>> = {};
	for (const interval of RECURRING_INTERVALS) {
		const binding = bindingFor(plan, row, interval);
		if (binding) {
			out[interval] = resolveProductId(binding, read);
		}
	}
	return out;
};

/** Decision + target terms + target products: any drift pauses a campaign. */
export const decisionHash = (
	decision: GrandfatheringDecision,
	read: (key: string) => string | undefined = (k) => process.env[k]
): string => {
	const to =
		decision.toVersion === null
			? null
			: rowOf(decision.plan, decision.toVersion);
	return sha256({
		decision,
		toProducts: to ? rowProductIds(decision.plan, to, read) : null,
		toTerms: to ? termsHash(to) : null,
	});
};
