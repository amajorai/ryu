import { describe, expect, test } from "bun:test";
import {
	ladderCharge,
	ladderDisclosure,
	ladderProblems,
	type ToolSpendLadder,
	toolSpendLadderSchema,
} from "./tool-spend-ladder.ts";

/** A synthetic ladder for the rules; no rung here is a Ryu price. */
const LADDER: ToolSpendLadder = toolSpendLadderSchema.parse({
	appliesTo: ["connect_vendor", "treg"],
	decision: {
		decidedOn: "2026-10-21",
		note: "Synthetic ladder for tests.",
		status: "decided",
	},
	enabled: true,
	rungs: [
		{ discountBps: 0, fromMicroUsd: 0, id: "base", label: "Base" },
		{ discountBps: 1000, fromMicroUsd: 1000, id: "ten", label: "10% off" },
		{ discountBps: 2500, fromMicroUsd: 5000, id: "quarter", label: "25% off" },
	],
	version: 1,
});

describe("tool spend ladder rules", () => {
	test("a decided, rising ladder is valid", () => {
		expect(ladderProblems(LADDER)).toEqual([]);
	});

	test("each broken rule is named", () => {
		const broken: ToolSpendLadder = {
			...LADDER,
			appliesTo: ["treg", "treg"],
			decision: { decidedOn: null, note: "Not yet.", status: "pending" },
			rungs: [
				{ discountBps: 100, fromMicroUsd: 10, id: "a", label: "A" },
				{ discountBps: 50, fromMicroUsd: 10, id: "a", label: "B" },
			],
		};
		expect(ladderProblems(broken)).toEqual([
			"discount_falls",
			"duplicate_reason",
			"duplicate_rung",
			"enabled_without_decision",
			"first_rung_not_base",
			"thresholds_not_rising",
		]);
		expect(ladderProblems({ ...LADDER, appliesTo: [], rungs: [] })).toEqual([
			"enabled_without_reasons",
			"enabled_without_rungs",
		]);
	});

	test("a discount deeper than half is refused by shape", () => {
		expect(
			toolSpendLadderSchema.safeParse({
				...LADDER,
				rungs: [{ discountBps: 5001, fromMicroUsd: 0, id: "x", label: "X" }],
			}).success
		).toBe(false);
	});
});

describe("tool spend ladder charges", () => {
	test("a charge is split across the rungs it falls in, discounts rounded down", () => {
		// Month so far 900: 100 at base, 4000 at 10%, 1 at 25%.
		expect(ladderCharge(LADDER, "connect_vendor", 900, 4101)).toEqual({
			chargedMicroUsd: 3701,
			discountMicroUsd: 400,
			listMicroUsd: 4101,
			slices: [
				{
					discountBps: 0,
					discountMicroUsd: 0,
					listMicroUsd: 100,
					rung: "base",
				},
				{
					discountBps: 1000,
					discountMicroUsd: 400,
					listMicroUsd: 4000,
					rung: "ten",
				},
				{
					discountBps: 2500,
					discountMicroUsd: 0,
					listMicroUsd: 1,
					rung: "quarter",
				},
			],
		});
	});

	test("a disabled, invalid or non-applying ladder charges the list price", () => {
		const list = {
			chargedMicroUsd: 500,
			discountMicroUsd: 0,
			listMicroUsd: 500,
			slices: [],
		};
		expect(
			ladderCharge({ ...LADDER, enabled: false }, "treg", 9000, 500)
		).toEqual(list);
		expect(ladderCharge(LADDER, "composio", 9000, 500)).toEqual(list);
		expect(
			ladderCharge(
				{ ...LADDER, rungs: [...LADDER.rungs].reverse() },
				"treg",
				9000,
				500
			)
		).toEqual(list);
	});

	test("the charge never exceeds the list price and the disclosure follows enablement", () => {
		for (const start of [0, 999, 1000, 4999, 5000, 123_456]) {
			for (const amount of [0, 1, 7, 1000, 99_999]) {
				const charge = ladderCharge(LADDER, "treg", start, amount);
				expect(charge.chargedMicroUsd).toBeLessThanOrEqual(amount);
				expect(charge.chargedMicroUsd + charge.discountMicroUsd).toBe(amount);
			}
		}
		expect(ladderDisclosure(LADDER)).toHaveLength(3);
		expect(ladderDisclosure({ ...LADDER, enabled: false })).toEqual([]);
	});
});
