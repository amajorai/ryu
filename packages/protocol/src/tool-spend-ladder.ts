/**
 * The shared-plan pricing ladder for tool spend (Treg parity C6): volume
 * rungs over an organization's calendar-month tool spend, each with a
 * discount on the spend that falls inside it, applied like tax brackets.
 *
 * This is a data model and its rules, not a price: Ryu ships it disabled with
 * no rungs (`TOOL_SPEND_LADDER` in `@ryu/auth/lib/plans`) until a pricing
 * decision sets them. A ladder can be enabled only once that decision is
 * recorded, its first rung starts at zero with no discount, thresholds rise,
 * discounts never fall, and every rung is disclosed exactly as charged.
 *
 * Money rules: a rung's discount is computed on list-price spend in integer
 * micro-USD and rounded down, so a charge is never below what the disclosure
 * promises the caller would pay; a disabled ladder charges the list price.
 */

import { z } from "zod";

export const TOOL_SPEND_LADDER_VERSION = 1;
export const MAX_LADDER_RUNGS = 10;
/** The deepest discount a rung may carry: 50%. */
export const MAX_LADDER_DISCOUNT_BPS = 5000;

/** The ledger reasons a ladder can apply to (tool calls only). */
export const LADDER_REASONS = [
	"composio",
	"connect_native",
	"connect_vendor",
	"treg",
] as const;
export type LadderReason = (typeof LADDER_REASONS)[number];

const RUNG_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

export const ladderRungSchema = z.strictObject({
	/** Discount on spend inside this rung, in basis points (100 = 1%). */
	discountBps: z.number().int().min(0).max(MAX_LADDER_DISCOUNT_BPS),
	/** Month-to-date list-price tool spend at which this rung starts. */
	fromMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	id: z.string().regex(RUNG_ID),
	label: z.string().trim().min(1).max(80),
});
export type LadderRung = z.output<typeof ladderRungSchema>;

export const toolSpendLadderSchema = z.strictObject({
	/** Which tool charges count toward the month and are discounted. */
	appliesTo: z.array(z.enum(LADDER_REASONS)).max(LADDER_REASONS.length),
	/** The commercial decision behind the rungs. */
	decision: z.strictObject({
		decidedOn: z.iso.date().nullable(),
		note: z.string().trim().min(1).max(500),
		status: z.enum(["pending", "decided"]),
	}),
	enabled: z.boolean(),
	rungs: z.array(ladderRungSchema).max(MAX_LADDER_RUNGS),
	version: z.literal(TOOL_SPEND_LADDER_VERSION),
});
export type ToolSpendLadder = z.output<typeof toolSpendLadderSchema>;

/** Every rule a ladder breaks, as sorted codes. Empty means valid. */
export function ladderProblems(ladder: ToolSpendLadder): string[] {
	const codes = new Set<string>();
	const { rungs } = ladder;
	const first = rungs[0];
	if (
		rungs.length > 0 &&
		!(first?.fromMicroUsd === 0 && first.discountBps === 0)
	) {
		codes.add("first_rung_not_base");
	}
	const ids = new Set<string>();
	for (const [index, rung] of rungs.entries()) {
		if (ids.has(rung.id)) {
			codes.add("duplicate_rung");
		}
		ids.add(rung.id);
		const previous = rungs[index - 1];
		if (previous && rung.fromMicroUsd <= previous.fromMicroUsd) {
			codes.add("thresholds_not_rising");
		}
		if (previous && rung.discountBps < previous.discountBps) {
			codes.add("discount_falls");
		}
	}
	if (new Set(ladder.appliesTo).size !== ladder.appliesTo.length) {
		codes.add("duplicate_reason");
	}
	if (ladder.enabled) {
		if (
			ladder.decision.status !== "decided" ||
			ladder.decision.decidedOn === null
		) {
			codes.add("enabled_without_decision");
		}
		if (rungs.length < 2) {
			codes.add("enabled_without_rungs");
		}
		if (ladder.appliesTo.length === 0) {
			codes.add("enabled_without_reasons");
		}
	}
	return [...codes].sort();
}

/** One rung's share of a charge. */
export interface LadderSlice {
	discountBps: number;
	discountMicroUsd: number;
	/** List-price spend of the charge inside this rung. */
	listMicroUsd: number;
	rung: string;
}

export interface LadderCharge {
	chargedMicroUsd: number;
	discountMicroUsd: number;
	listMicroUsd: number;
	slices: LadderSlice[];
}

/**
 * Price one charge of `amountMicroUsd` (list price) made when the
 * organization's month-to-date list-price tool spend was `monthToDateMicroUsd`.
 * The charge is split across the rungs it falls in; each slice's discount is
 * rounded down. A disabled or invalid ladder, or a reason it does not apply
 * to, charges the list price.
 */
export function ladderCharge(
	ladder: ToolSpendLadder,
	reason: string,
	monthToDateMicroUsd: number,
	amountMicroUsd: number
): LadderCharge {
	const list = Math.max(0, Math.trunc(amountMicroUsd));
	const plain: LadderCharge = {
		chargedMicroUsd: list,
		discountMicroUsd: 0,
		listMicroUsd: list,
		slices: [],
	};
	if (
		!ladder.enabled ||
		list === 0 ||
		!(ladder.appliesTo as readonly string[]).includes(reason) ||
		ladderProblems(ladder).length > 0
	) {
		return plain;
	}
	const start = Math.max(0, Math.trunc(monthToDateMicroUsd));
	const end = start + list;
	const slices: LadderSlice[] = [];
	let discount = 0;
	for (const [index, rung] of ladder.rungs.entries()) {
		const next =
			ladder.rungs[index + 1]?.fromMicroUsd ?? Number.POSITIVE_INFINITY;
		const low = Math.max(start, rung.fromMicroUsd);
		const high = Math.min(end, next);
		if (high <= low) {
			continue;
		}
		const inside = high - low;
		const off = Math.floor((inside * rung.discountBps) / 10_000);
		discount += off;
		slices.push({
			discountBps: rung.discountBps,
			discountMicroUsd: off,
			listMicroUsd: inside,
			rung: rung.id,
		});
	}
	return {
		chargedMicroUsd: list - discount,
		discountMicroUsd: discount,
		listMicroUsd: list,
		slices,
	};
}

/** One published line of a ladder, as the pricing page must show it. */
export interface LadderDisclosure {
	discountBps: number;
	fromMicroUsd: number;
	label: string;
}

/** What a pricing page must disclose: every rung, or nothing while disabled. */
export function ladderDisclosure(ladder: ToolSpendLadder): LadderDisclosure[] {
	if (!ladder.enabled) {
		return [];
	}
	return ladder.rungs.map((rung) => ({
		discountBps: rung.discountBps,
		fromMicroUsd: rung.fromMicroUsd,
		label: rung.label,
	}));
}
