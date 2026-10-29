/**
 * Builder tags and per-tag budgets (Treg parity C6).
 *
 * A caller labels a metered call with up to eight tags in the `x-ryu-tags`
 * header (`x-ryu-tags: checkout-agent, eu`). Tags are the caller's own
 * attribution: they ride on the call's receipt and ledger row, so spend can be
 * broken down and exported per tag. An organization's admins may set a budget
 * per tag and UTC window (`daily` or `monthly`):
 *
 * - `block`: a charged call carrying the tag is refused before it runs once
 *   the window's tagged spend has reached the limit, or would pass it with the
 *   call's estimate;
 * - `alert`: nothing is refused; the budget reports itself exceeded.
 *
 * A budget is only as strong as the caller's tagging: an untagged call is
 * never counted against a tag. A call that charges nothing (a call on the
 * tenant's own key, a free route) is never refused by a tag budget.
 *
 * Budgets are authored in the control plane and pulled by every enforcing
 * service (Connect through its policy feed, Gateway through `/gateway/resolve`)
 * with a spend snapshot measured from the control plane's tag spend rollup.
 * A service admits against the snapshot plus its own tagged spend the
 * snapshot cannot contain yet (`countedSince`), so the budget is shared
 * across services without double counting settled spend.
 *
 * The Rust twin is `ryu_gw_contracts::spend_tags`; both are held to
 * `crates/gateway/contracts/fixtures/spend-tags-cases-v1.json`. Connect keeps a
 * port in `apps/connect/src/spend-tags.ts` held to the same file.
 */

import { z } from "zod";

export const SPEND_TAGS_CONTRACT_VERSION = 1;

/** The request header that carries a call's tags. */
export const SPEND_TAGS_HEADER = "x-ryu-tags";
export const MAX_SPEND_TAGS = 8;
export const MAX_SPEND_TAG_LEN = 64;
/** A header longer than this is refused before it is split. */
export const MAX_SPEND_TAGS_HEADER_LEN = 600;
export const MAX_TAG_BUDGETS_PER_ORG = 100;
/** The largest budget limit: $1m, the largest single debit. */
export const MAX_TAG_BUDGET_MICRO_USD = 1_000_000_000_000;

const TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;
const BUDGET_ID = /^tbg_[a-z0-9]{8,64}$/u;

export const TAG_BUDGET_WINDOWS = ["daily", "monthly"] as const;
export type TagBudgetWindow = (typeof TAG_BUDGET_WINDOWS)[number];
export const TAG_BUDGET_ACTIONS = ["block", "alert"] as const;
export type TagBudgetAction = (typeof TAG_BUDGET_ACTIONS)[number];

/** Why a tags header is refused. */
export type SpendTagsProblem =
	| "too_long"
	| "empty_tag"
	| "invalid_tag"
	| "too_many";

export type SpendTagsParse =
	| { ok: true; tags: string[] }
	| { ok: false; problem: SpendTagsProblem };

/**
 * Parse an `x-ryu-tags` value. Absent or blank is no tags. Items are
 * comma-separated, trimmed and lowercased; each must match
 * `[a-z0-9][a-z0-9._:-]{0,63}`. Duplicates collapse; the result is sorted.
 * An empty item (`a,,b`), an invalid item, more than eight distinct tags or a
 * header over 600 characters is refused.
 */
export function parseSpendTags(raw: string | null | undefined): SpendTagsParse {
	if (raw === null || raw === undefined) {
		return { ok: true, tags: [] };
	}
	if (raw.length > MAX_SPEND_TAGS_HEADER_LEN) {
		return { ok: false, problem: "too_long" };
	}
	if (raw.trim() === "") {
		return { ok: true, tags: [] };
	}
	const tags = new Set<string>();
	for (const item of raw.split(",")) {
		const tag = item.trim().toLowerCase();
		if (tag === "") {
			return { ok: false, problem: "empty_tag" };
		}
		if (!TAG.test(tag)) {
			return { ok: false, problem: "invalid_tag" };
		}
		tags.add(tag);
	}
	if (tags.size > MAX_SPEND_TAGS) {
		return { ok: false, problem: "too_many" };
	}
	return { ok: true, tags: [...tags].sort() };
}

/** Whether one string is a valid, already-normalized tag. */
export function isSpendTag(value: string): boolean {
	return TAG.test(value);
}

export const spendTagSchema = z.string().regex(TAG);

export const tagBudgetSchema = z.strictObject({
	action: z.enum(TAG_BUDGET_ACTIONS),
	id: z.string().regex(BUDGET_ID),
	limitMicroUsd: z.number().int().nonnegative().max(MAX_TAG_BUDGET_MICRO_USD),
	tag: spendTagSchema,
	window: z.enum(TAG_BUDGET_WINDOWS),
});
export type TagBudget = z.output<typeof tagBudgetSchema>;

/** A budget with the spend the control plane measured in its window. */
export const tagBudgetStateSchema = tagBudgetSchema.extend({
	spentMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	/** Start of the UTC window the spend covers. */
	windowStart: z.iso.datetime({ offset: true }),
});
export type TagBudgetState = z.output<typeof tagBudgetStateSchema>;

/**
 * One organization's budgets as a service pulls them. `countedSince` is where
 * the snapshot stops counting this service's own spend: the service adds its
 * tagged spend recorded at or after it (Connect: its settlement cursor;
 * Gateway: the snapshot time, since its debits land as they happen).
 */
export const tenantTagBudgetsSchema = z.strictObject({
	asOf: z.iso.datetime({ offset: true }),
	budgets: z.array(tagBudgetStateSchema).max(MAX_TAG_BUDGETS_PER_ORG),
	countedSince: z.iso.datetime({ offset: true }),
});
export type TenantTagBudgets = z.output<typeof tenantTagBudgetsSchema>;

/**
 * Rules a budget list keeps beyond its shape: unique ids, one budget per tag
 * and window, at most 100. Returns the first problem, or null.
 */
export function tagBudgetsProblem(
	budgets: readonly Pick<TagBudget, "id" | "tag" | "window">[]
): string | null {
	if (budgets.length > MAX_TAG_BUDGETS_PER_ORG) {
		return `more than ${MAX_TAG_BUDGETS_PER_ORG} tag budgets`;
	}
	const ids = new Set<string>();
	const slots = new Set<string>();
	for (const budget of budgets) {
		if (ids.has(budget.id)) {
			return `duplicate tag budget ${budget.id}`;
		}
		ids.add(budget.id);
		const slot = `${budget.tag}\u0000${budget.window}`;
		if (slots.has(slot)) {
			return `duplicate ${budget.window} budget for tag ${budget.tag}`;
		}
		slots.add(slot);
	}
	return null;
}

const DAY_MS = 86_400_000;

/** Start of the UTC window containing `nowMs`, in epoch milliseconds. */
export function tagBudgetWindowStart(
	window: TagBudgetWindow,
	nowMs: number
): number {
	if (window === "daily") {
		return Math.floor(nowMs / DAY_MS) * DAY_MS;
	}
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** End (exclusive) of the UTC window containing `nowMs`, in epoch milliseconds. */
export function tagBudgetWindowEnd(
	window: TagBudgetWindow,
	nowMs: number
): number {
	if (window === "daily") {
		return tagBudgetWindowStart(window, nowMs) + DAY_MS;
	}
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * How a service counts one budget now: the snapshot's spend when it describes
 * the current window (else zero: the window rolled over since it was taken),
 * and the instant from which the service adds its own tagged spend, the later
 * of `countedSince` and the window start.
 */
export function tagBudgetBasis(
	budget: Pick<TagBudgetState, "spentMicroUsd" | "window" | "windowStart">,
	countedSinceMs: number,
	nowMs: number
): { localFromMs: number; snapshotMicroUsd: number } {
	const windowStart = tagBudgetWindowStart(budget.window, nowMs);
	const snapshotWindow = Date.parse(budget.windowStart);
	return {
		localFromMs: Math.max(countedSinceMs, windowStart),
		snapshotMicroUsd: snapshotWindow === windowStart ? budget.spentMicroUsd : 0,
	};
}

/** One budget the decision looked at, with what it counted. */
export interface TagBudgetUse {
	action: TagBudgetAction;
	id: string;
	limitMicroUsd: number;
	tag: string;
	/** Tagged spend counted in the window before this call. */
	usedMicroUsd: number;
	window: TagBudgetWindow;
}

export interface TagBudgetDecision {
	/** `alert` budgets this call reaches or passes (never refused). */
	alerts: TagBudgetUse[];
	/** The `block` budget that refuses the call, or null. */
	blocked: TagBudgetUse | null;
}

/** Whether a budget is reached by a call with this estimate. */
export function tagBudgetReached(
	usedMicroUsd: number,
	estimateMicroUsd: number,
	limitMicroUsd: number
): boolean {
	return (
		usedMicroUsd >= limitMicroUsd ||
		usedMicroUsd + estimateMicroUsd > limitMicroUsd
	);
}

/** Code-unit order on ids, the same order the Rust twin sorts in. */
function byId(left: { id: string }, right: { id: string }): number {
	if (left.id === right.id) {
		return 0;
	}
	return left.id < right.id ? -1 : 1;
}

/**
 * Decide one charged call against the budgets of its tags. A budget applies
 * when its tag is one of the call's. It is reached when the counted spend is
 * already at its limit, or the call's estimate would pass it (an estimate of
 * zero means the price is not known before the call). The refusing budget is
 * the reached `block` budget with the least room left, then the lowest id.
 */
export function decideTagBudgets(input: {
	budgets: readonly TagBudgetUse[];
	estimateMicroUsd: number;
	tags: readonly string[];
}): TagBudgetDecision {
	const tags = new Set(input.tags);
	const alerts: TagBudgetUse[] = [];
	let blocked: TagBudgetUse | null = null;
	const room = (use: TagBudgetUse) => use.limitMicroUsd - use.usedMicroUsd;
	for (const use of input.budgets) {
		if (
			!(
				tags.has(use.tag) &&
				tagBudgetReached(
					use.usedMicroUsd,
					input.estimateMicroUsd,
					use.limitMicroUsd
				)
			)
		) {
			continue;
		}
		if (use.action === "alert") {
			alerts.push(use);
			continue;
		}
		if (
			blocked === null ||
			room(use) < room(blocked) ||
			(room(use) === room(blocked) && byId(use, blocked) < 0)
		) {
			blocked = use;
		}
	}
	alerts.sort(byId);
	return { alerts, blocked };
}
