import { describe, expect, test } from "bun:test";
// The Rust contract's shared cases are the source of truth for both twins.
import cases from "../../../crates/gateway/contracts/fixtures/spend-tags-cases-v1.json" with {
	type: "json",
};
import {
	decideTagBudgets,
	parseSpendTags,
	SPEND_TAGS_CONTRACT_VERSION,
	type TagBudgetUse,
	tagBudgetBasis,
	tagBudgetSchema,
	tagBudgetsProblem,
	tagBudgetWindowEnd,
	tagBudgetWindowStart,
} from "./spend-tags.ts";

describe("spend tags shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(SPEND_TAGS_CONTRACT_VERSION);
	});

	for (const shared of cases.headers) {
		test(`header: ${shared.name}`, () => {
			expect(parseSpendTags(shared.raw)).toStrictEqual(
				shared.expected as ReturnType<typeof parseSpendTags>
			);
		});
	}

	test("header: over the length limit", () => {
		expect(parseSpendTags("a".repeat(cases.longHeader.length))).toStrictEqual(
			cases.longHeader.expected as ReturnType<typeof parseSpendTags>
		);
	});

	for (const shared of cases.validation) {
		test(`validation: ${shared.name}`, () => {
			const problem = tagBudgetsProblem(
				shared.budgets as Parameters<typeof tagBudgetsProblem>[0]
			);
			if (shared.problem === null) {
				expect(problem).toBeNull();
			} else {
				expect(problem ?? "").toContain(shared.problem);
			}
		});
	}

	for (const shared of cases.windows) {
		test(`window: ${shared.window} at ${shared.now}`, () => {
			const window = shared.window as "daily" | "monthly";
			const now = Date.parse(shared.now);
			expect(new Date(tagBudgetWindowStart(window, now)).toISOString()).toBe(
				shared.start
			);
			expect(new Date(tagBudgetWindowEnd(window, now)).toISOString()).toBe(
				shared.end
			);
		});
	}

	for (const shared of cases.basis) {
		test(`basis: ${shared.name}`, () => {
			const basis = tagBudgetBasis(
				{
					...shared.budget,
					window: shared.budget.window as "daily" | "monthly",
				},
				Date.parse(shared.countedSince),
				Date.parse(shared.now)
			);
			expect({
				localFrom: new Date(basis.localFromMs).toISOString(),
				snapshotMicroUsd: basis.snapshotMicroUsd,
			}).toStrictEqual(shared.expected);
		});
	}

	for (const shared of cases.decisions) {
		test(`decision: ${shared.name}`, () => {
			const decision = decideTagBudgets({
				budgets: shared.budgets as TagBudgetUse[],
				estimateMicroUsd: shared.estimateMicroUsd,
				tags: shared.tags,
			});
			expect(JSON.parse(JSON.stringify(decision))).toStrictEqual(
				shared.expected
			);
		});
	}
});

describe("spend tags shapes", () => {
	test("a budget id needs the tbg_ prefix and a lowercase tag", () => {
		const base = {
			action: "block",
			id: "tbg_abcdef12",
			limitMicroUsd: 1000,
			tag: "eu",
			window: "daily",
		};
		expect(tagBudgetSchema.safeParse(base).success).toBe(true);
		expect(tagBudgetSchema.safeParse({ ...base, id: "abcdef12" }).success).toBe(
			false
		);
		expect(tagBudgetSchema.safeParse({ ...base, tag: "EU" }).success).toBe(
			false
		);
		expect(
			tagBudgetSchema.safeParse({ ...base, window: "weekly" }).success
		).toBe(false);
	});

	test("a budget can never refuse a call that is not tagged with it", () => {
		for (const shared of cases.decisions) {
			const decision = decideTagBudgets({
				budgets: shared.budgets as TagBudgetUse[],
				estimateMicroUsd: shared.estimateMicroUsd,
				tags: shared.tags,
			});
			if (decision.blocked) {
				expect(shared.tags).toContain(decision.blocked.tag);
				expect(decision.blocked.action).toBe("block");
			}
		}
	});
});
