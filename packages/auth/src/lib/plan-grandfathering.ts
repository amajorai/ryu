import type { IsoDate } from "./plan-variants.ts";
import {
	type BillingInterval,
	GRANDFATHER_PROMISE_CHANGED_ON,
	isCurrentRow,
	monthlyCreditPoolMicroUsdForSeats,
	monthlyPriceMicroUsdForSeats,
	PLAN_IDS,
	PLAN_VERSIONS,
	PLANS,
	type PlanId,
	type PlanVersion,
	rowRegions,
	rowVariant,
} from "./plans.ts";
import { SELF_SERVE_MAX_SEATS } from "./seat-tiers.ts";

/**
 * GRANDFATHERING — what happens to a subscriber when the price they bought is
 * no longer the price we sell.
 *
 * Every superseded version row has an EXPLICIT fate, chosen by a person and
 * recorded here with who decided it, when and why:
 *
 *  - `forever`      the subscriber keeps their row for as long as they stay
 *                   subscribed. The only fate any row has had so far.
 *  - `until`        they keep it until a date, then move to the target row at
 *                   their first renewal on or after it (and at least
 *                   `noticeDays` after a notice we confirmed was sent).
 *  - `next_renewal` they move at their first renewal at least `noticeDays`
 *                   after the notice (and not before `notBefore`).
 *
 * A move is NEVER silent and NEVER mid-term: it happens only at a billing
 * period end, only after a ledger-confirmed email to the payer of record, and
 * a yearly subscriber keeps the price for the term they already paid. The
 * migration job (`plan-migration.ts` in the API) is the only thing that acts on
 * a non-forever decision, and only once an admin arms it after a dry run.
 *
 * APPEND ONLY. To change a fate, append a NEW decision for the same row; the
 * last entry wins and the history stays. `money-path-invariants.test.ts` keeps
 * a frozen snapshot of the shipped entries and fails on any edit or removal.
 *
 * Pure and client-safe (no crypto, no product ids). Hashing lives in
 * `plan-terms.ts`.
 */

export type GrandfatheringPolicy =
	| { readonly kind: "forever" }
	| {
			readonly kind: "until";
			readonly noticeDays: number;
			readonly until: IsoDate;
	  }
	| {
			readonly kind: "next_renewal";
			readonly noticeDays: number;
			readonly notBefore?: IsoDate;
	  };

/** A policy that moves subscribers (everything but `forever`). */
export type MovingPolicy = Exclude<GrandfatheringPolicy, { kind: "forever" }>;

export interface GrandfatheringDecision {
	readonly decidedBy: string;
	readonly decidedOn: IsoDate;
	readonly fromVersion: number;
	/** Stable kebab id; also the migration campaign id. */
	readonly id: string;
	/**
	 * Required to move a row sold under the "keep your price" promise to a worse
	 * price or pool. Counsel must have reviewed the notice and terms first.
	 */
	readonly overridesForeverPromise?: {
		readonly approvedBy: string;
		readonly counselReviewedOn: IsoDate;
		readonly note: string;
	};
	readonly plan: PlanId;
	readonly policy: GrandfatheringPolicy;
	/** Optional one sentence the customer email may quote. */
	readonly publicReason?: string;
	/** Internal reasoning. */
	readonly rationale: string;
	/** Null exactly when the policy is `forever`. */
	readonly toVersion: number | null;
}

/** Minimum notice before any price change, counted from a confirmed send. */
export const MIN_PRICE_CHANGE_NOTICE_DAYS = 30;
/** Reminder lead before the effective date (monthly / yearly). */
export const PRICE_CHANGE_REMINDER_DAYS = 7;
export const YEARLY_REMINDER_DAYS = 30;
/** The apply window before a renewal boundary. */
export const APPLY_LEAD_MAX_MS = 6 * 3_600_000;
export const APPLY_LEAD_MIN_MS = 15 * 60_000;
/** Apply at least this long before the boundary, so Polar renews on the new product. */
export const APPLY_CLOSE_BEFORE_MS = 10 * 60_000;
/** The largest proration a migration may cause for the final hours of a term. */
export const MIGRATION_DUST_CAP_MICRO_USD = 1_000_000;
/** A migration that cannot settle after this many re-plans fails for review. */
export const MAX_REPLANS = 6;

const BACKFILL = {
	decidedBy: "founder",
	decidedOn: "2026-10-18",
	policy: { kind: "forever" },
	rationale:
		"Existing behaviour: every row sold so far was sold under the 'existing customers keep their price and pool' promise.",
	toVersion: null,
} as const;

const forever = (
	plan: PlanId,
	fromVersion: number
): GrandfatheringDecision => ({
	...BACKFILL,
	fromVersion,
	id: `${plan}-v${fromVersion}-forever`,
	plan,
});

/**
 * The decision list. Backfilled with one `forever` per superseded row: that is
 * what the catalog has always done, now stated rather than implied.
 */
export const GRANDFATHERING_DECISIONS: readonly GrandfatheringDecision[] = [
	forever("desktop-license", 1),
	forever("desktop-license", 2),
	forever("desktop-license", 3),
	forever("desktop-license", 5),
	forever("marketplace-membership", 1),
	forever("marketplace-membership", 2),
	forever("marketplace-membership", 3),
	forever("marketplace-membership", 4),
	forever("marketplace-membership", 5),
	forever("pro", 1),
	forever("pro", 2),
	forever("pro", 3),
	forever("pro", 4),
	forever("pro", 5),
	forever("max", 1),
	forever("max", 2),
	forever("max", 3),
	forever("max", 5),
	forever("teams", 1),
	forever("teams", 2),
	forever("teams", 3),
	forever("teams", 4),
	forever("business", 1),
	// Plus v2 and Pro v7 (the $9 and $14 pool rows) superseded these two.
	forever("plus", 1),
	forever("pro", 6),
];

/** The decision in force for a row: the LAST entry for it. */
export const decisionFor = (
	plan: PlanId,
	fromVersion: number,
	decisions: readonly GrandfatheringDecision[] = GRANDFATHERING_DECISIONS
): GrandfatheringDecision | null =>
	[...decisions]
		.reverse()
		.find(
			(decision) =>
				decision.plan === plan && decision.fromVersion === fromVersion
		) ?? null;

/** A decision by id, only while it is still the one in force for its row. */
export const decisionById = (
	id: string,
	decisions: readonly GrandfatheringDecision[] = GRANDFATHERING_DECISIONS
): GrandfatheringDecision | null => {
	const decision = decisions.find((candidate) => candidate.id === id);
	if (!decision) {
		return null;
	}
	return decisionFor(decision.plan, decision.fromVersion, decisions)?.id === id
		? decision
		: null;
};

export const rowOf = (plan: PlanId, version: number): PlanVersion | null =>
	PLAN_VERSIONS[plan].find((row) => row.version === version) ?? null;

/** Seat counts a migration is classified across. */
const classificationSeats = (plan: PlanId): number[] => {
	const model = PLANS[plan].seatModel;
	if (model.kind !== "per_seat") {
		return [1];
	}
	const seats: number[] = [];
	for (let count = model.minSeats; count <= SELF_SERVE_MAX_SEATS; count++) {
		seats.push(count);
	}
	return seats;
};

export type MigrationClass = "adverse" | "favourable" | "neutral";

/**
 * Adverse when ANY seat count pays more or gets a smaller pool; favourable when
 * none is adverse and some count is strictly better; otherwise neutral.
 */
export const classifyMigration = (
	plan: PlanId,
	from: PlanVersion,
	to: PlanVersion
): MigrationClass => {
	const catalog = PLANS[plan];
	let better = false;
	for (const seats of classificationSeats(plan)) {
		const priceFrom = monthlyPriceMicroUsdForSeats({
			plan: catalog,
			seats,
			version: from,
		});
		const priceTo = monthlyPriceMicroUsdForSeats({
			plan: catalog,
			seats,
			version: to,
		});
		const poolFrom = monthlyCreditPoolMicroUsdForSeats({
			plan: catalog,
			seats,
			version: from,
		});
		const poolTo = monthlyCreditPoolMicroUsdForSeats({
			plan: catalog,
			seats,
			version: to,
		});
		if (priceTo > priceFrom || poolTo < poolFrom) {
			return "adverse";
		}
		if (priceTo < priceFrom || poolTo > poolFrom) {
			better = true;
		}
	}
	return better ? "favourable" : "neutral";
};

const DAY_MS = 24 * 3_600_000;

const isoDateMs = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`);

/**
 * Calendar add in UTC with the day clamped to the target month's length
 * (Jan 31 + 1 month = Feb 28/29), the way a subscription renews.
 */
export const addInterval = (
	date: Date,
	interval: "monthly" | "yearly",
	count: number
): Date => {
	const months = interval === "yearly" ? 12 * count : count;
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + months;
	const targetYear = year + Math.floor(month / 12);
	const targetMonth = ((month % 12) + 12) % 12;
	const lastDay = new Date(
		Date.UTC(targetYear, targetMonth + 1, 0)
	).getUTCDate();
	return new Date(
		Date.UTC(
			targetYear,
			targetMonth,
			Math.min(date.getUTCDate(), lastDay),
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds(),
			date.getUTCMilliseconds()
		)
	);
};

export interface MigrationSubscriptionState {
	readonly cancelAtPeriodEnd: boolean;
	readonly currentPeriodEnd: Date | null;
	readonly interval: "monthly" | "yearly";
	readonly pendingUpdate: boolean;
	readonly status: string;
}

export type ScheduleSkip =
	| "inactive"
	| "cancelling"
	| "no_period_end"
	| "pending_update";

export type ScheduleResult =
	| {
			readonly applyAfter: Date;
			readonly applyBefore: Date;
			readonly effectiveAt: Date;
			readonly noticeBy: Date;
			readonly prorationBoundMicroUsd: number;
			readonly reminderAt: Date | null;
	  }
	| { readonly skip: ScheduleSkip };

/** How many renewals ahead the schedule will look before giving up. */
const MAX_PERIODS_AHEAD = 120;

/**
 * When one subscription moves under a moving policy. Pure.
 *
 * `noticeAt` is the instant the notice was CONFIRMED sent (use `now` when
 * planning). The effective date is always a renewal boundary at least
 * `noticeDays` after it, never earlier than `notEarlierThan` (a date already
 * promised only ever moves later), and for a yearly subscriber may be a year
 * out: the term they paid for keeps its price.
 *
 * The apply window ends 10 minutes before the boundary and opens early enough
 * for Polar to renew on the new product, but late enough that the proration
 * for the remaining minutes stays under {@link MIGRATION_DUST_CAP_MICRO_USD}
 * (clamped to 15 min .. 6 h).
 */
export const migrationScheduleFor = (input: {
	/** |to - from| of the INTERVAL price at the subscription's seats. */
	intervalDeltaMicroUsd: number;
	noticeAt: Date;
	notEarlierThan?: Date | null;
	policy: MovingPolicy;
	sub: MigrationSubscriptionState;
}): ScheduleResult => {
	const status = input.sub.status.toLowerCase();
	if (status !== "active" && status !== "trialing") {
		return { skip: "inactive" };
	}
	if (input.sub.cancelAtPeriodEnd) {
		return { skip: "cancelling" };
	}
	if (input.sub.pendingUpdate) {
		return { skip: "pending_update" };
	}
	const periodEnd = input.sub.currentPeriodEnd;
	if (!periodEnd || Number.isNaN(periodEnd.getTime())) {
		return { skip: "no_period_end" };
	}
	const noticeDays = input.policy.noticeDays;
	let earliest = input.noticeAt.getTime() + noticeDays * DAY_MS;
	if (input.policy.kind === "until") {
		earliest = Math.max(earliest, isoDateMs(input.policy.until));
	}
	if (input.policy.kind === "next_renewal" && input.policy.notBefore) {
		earliest = Math.max(earliest, isoDateMs(input.policy.notBefore));
	}
	if (input.notEarlierThan) {
		earliest = Math.max(earliest, input.notEarlierThan.getTime());
	}
	let effectiveAt: Date | null = null;
	for (let k = 0; k <= MAX_PERIODS_AHEAD; k++) {
		const candidate = addInterval(periodEnd, input.sub.interval, k);
		if (candidate.getTime() >= earliest) {
			effectiveAt = candidate;
			break;
		}
	}
	if (!effectiveAt) {
		return { skip: "no_period_end" };
	}
	const noticeBy = new Date(effectiveAt.getTime() - noticeDays * DAY_MS);
	const reminderDays =
		input.sub.interval === "yearly"
			? YEARLY_REMINDER_DAYS
			: PRICE_CHANGE_REMINDER_DAYS;
	const reminderCandidate = new Date(
		effectiveAt.getTime() - reminderDays * DAY_MS
	);
	const reminderAt =
		reminderCandidate.getTime() > input.noticeAt.getTime() + DAY_MS
			? reminderCandidate
			: null;
	const periodMs =
		effectiveAt.getTime() -
		addInterval(effectiveAt, input.sub.interval, -1).getTime();
	const delta = Math.abs(input.intervalDeltaMicroUsd);
	const rawLead =
		delta === 0
			? APPLY_LEAD_MAX_MS
			: (periodMs * MIGRATION_DUST_CAP_MICRO_USD) / delta;
	const lead = Math.min(
		APPLY_LEAD_MAX_MS,
		Math.max(APPLY_LEAD_MIN_MS, rawLead)
	);
	return {
		applyAfter: new Date(effectiveAt.getTime() - lead),
		applyBefore: new Date(effectiveAt.getTime() - APPLY_CLOSE_BEFORE_MS),
		effectiveAt,
		noticeBy,
		prorationBoundMicroUsd: Math.ceil((delta * lead) / periodMs),
		reminderAt,
	};
};

/** The interval multiplier of a monthly price (yearly bills 10 months). */
export const intervalPriceFactor = (interval: BillingInterval): number =>
	interval === "yearly" ? 10 : 1;

/**
 * Every problem with a decision, empty when it is valid. Enforced over the
 * whole catalog by tests, and again when an admin previews or arms one.
 */
export const decisionProblems = (
	decision: GrandfatheringDecision,
	promiseChangedOn: IsoDate | null = GRANDFATHER_PROMISE_CHANGED_ON
): string[] => {
	const problems: string[] = [];
	const from = rowOf(decision.plan, decision.fromVersion);
	if (!from) {
		return [`${decision.plan} v${decision.fromVersion} does not exist`];
	}
	if (decision.policy.kind === "forever") {
		if (decision.toVersion !== null) {
			problems.push("a forever decision must not name a target version");
		}
		return problems;
	}
	if (decision.toVersion === null) {
		return ["a moving decision must name a target version"];
	}
	const to = rowOf(decision.plan, decision.toVersion);
	if (!to) {
		return [`${decision.plan} v${decision.toVersion} does not exist`];
	}
	if (decision.toVersion <= decision.fromVersion) {
		problems.push("the target must be a later version");
	}
	const fromVariant = rowVariant(from);
	const toVariant = rowVariant(to);
	if (
		fromVariant.provider !== toVariant.provider ||
		fromVariant.capacity !== toVariant.capacity
	) {
		problems.push("a migration may not change provider or capacity");
	}
	const toRegions = rowRegions(to);
	if (!rowRegions(from).every((region) => toRegions.includes(region))) {
		problems.push("the target must be sold in every region the source was");
	}
	if (!isCurrentRow(decision.plan, to)) {
		problems.push("the target must be the row currently sold");
	}
	if (decision.policy.noticeDays < MIN_PRICE_CHANGE_NOTICE_DAYS) {
		problems.push(
			`notice must be at least ${MIN_PRICE_CHANGE_NOTICE_DAYS} days`
		);
	}
	if (
		decision.policy.kind === "until" &&
		isoDateMs(decision.policy.until) <
			isoDateMs(decision.decidedOn) + decision.policy.noticeDays * DAY_MS
	) {
		problems.push(
			"`until` must leave the full notice period after the decision"
		);
	}
	const sold = from.soldUnder ?? "pinned";
	if (
		classifyMigration(decision.plan, from, to) === "adverse" &&
		sold !== "notice_may_change" &&
		!decision.overridesForeverPromise
	) {
		problems.push(
			"an adverse move of a row sold under the keep-your-price promise needs overridesForeverPromise"
		);
	}
	if (
		to.soldUnder === "notice_may_change" &&
		!(promiseChangedOn && to.shippedOn && to.shippedOn >= promiseChangedOn)
	) {
		problems.push(
			"notice_may_change is only valid for rows shipped after the public promise changed"
		);
	}
	return problems;
};

/** Rows that are not current and have no decision (must be empty). */
export const rowsWithoutDecision = (
	decisions: readonly GrandfatheringDecision[] = GRANDFATHERING_DECISIONS
): string[] => {
	const missing: string[] = [];
	for (const planId of PLAN_IDS) {
		for (const row of PLAN_VERSIONS[planId]) {
			if (
				!(
					isCurrentRow(planId, row) ||
					decisionFor(planId, row.version, decisions)
				)
			) {
				missing.push(`${planId} v${row.version}`);
			}
		}
	}
	return missing;
};
