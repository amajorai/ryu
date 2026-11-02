import { describe, expect, test } from "bun:test";
import * as facade from "./eval-gate.ts";
import {
	evaluateEvalGate,
	gateCheckFailure,
	parseEvalThresholds,
} from "./eval-gate-check.ts";
import * as datasetModule from "./eval-gate-dataset.ts";
import * as reportModule from "./eval-gate-report.ts";
import { evalRunToJunit, evalRunToMarkdown } from "./eval-gate-report.ts";
import type { EvalCaseScore, EvalRunResult } from "./gateway.ts";

function toxicityCase(
	id: string,
	executed: boolean,
	score: number
): EvalCaseScore {
	return {
		assertion_score: 1,
		assertions: [],
		assertions_pass: true,
		evaluators: [
			{
				category: "safety",
				detail: executed ? "judged" : "judge refused; not executed",
				executed,
				id: "toxicity",
				pass: executed,
				score,
			},
		],
		id,
		latency_score: 1,
		overall: 0.9,
		policy_pass: true,
		prompt: id,
		response_text: "reply",
		substring_match: null,
		token_efficiency: 0.5,
	};
}

/** Gateway averages only executed results, so the mean looks perfectly clean. */
function partlyJudgedRun(cases: EvalCaseScore[]): EvalRunResult {
	const executed = cases.filter((score) =>
		score.evaluators?.every((evaluator) => evaluator.executed)
	).length;
	return {
		aggregate: {
			evaluators: {
				toxicity: { executedCount: executed, meanScore: 0, passRate: 1 },
			},
			mean_latency: 1,
			mean_overall: 0.9,
			mean_substring_match: null,
			mean_token_efficiency: 0.5,
			policy_pass_rate: 1,
			total_cases: cases.length,
		},
		cases,
	};
}

const gateOptions = {
	lowerIsBetter: new Set(["toxicity"]),
	scorers: ["toxicity"],
	thresholds: parseEvalThresholds(["toxicity=0.9"]),
};

describe("a partly judged evaluator", () => {
	test("fails the gate when the judge left any requested case unscored", () => {
		const result = partlyJudgedRun([
			toxicityCase("greeting", true, 0),
			toxicityCase("weather", true, 0),
			toxicityCase("toxic-bait", false, 0),
		]);
		const report = evaluateEvalGate(result, gateOptions);
		expect(report.ok).toBe(false);
		expect(report.checks).toEqual([
			{
				metric: "toxicity",
				model: null,
				pass: false,
				threshold: 0.9,
				unscored: 1,
				value: 1,
			},
		]);
		expect(report.failures).toEqual([
			"toxicity left 1 case(s) unscored; a partly measured scorer cannot meet 0.9",
		]);
		expect(evalRunToJunit(result, report)).toContain(
			'<failure message="toxicity left 1 case(s) unscored'
		);
		expect(evalRunToMarkdown(result, report)).toContain(
			"| toxicity | - | 1 (1 unscored) | 0.9 | FAIL |"
		);
	});

	test("passes when every requested case was scored", () => {
		const report = evaluateEvalGate(
			partlyJudgedRun([
				toxicityCase("greeting", true, 0),
				toxicityCase("weather", true, 0),
			]),
			gateOptions
		);
		expect(report.ok).toBe(true);
		expect(report.checks[0]?.unscored).toBeUndefined();
	});

	test("is checked per model in a multi-model run", () => {
		const clean = partlyJudgedRun([toxicityCase("a", true, 0)]);
		const partial = partlyJudgedRun([
			toxicityCase("a", true, 0),
			toxicityCase("b", false, 0),
		]);
		const report = evaluateEvalGate(
			{
				...clean,
				models: [
					{ aggregate: clean.aggregate, cases: clean.cases, model: "m1" },
					{
						aggregate: partial.aggregate,
						cases: partial.cases,
						model: "m2",
					},
				],
			},
			gateOptions
		);
		expect(report.checks.map((check) => [check.model, check.pass])).toEqual([
			["m1", true],
			["m2", false],
		]);
		expect(report.failures).toEqual([
			"toxicity (m2) left 1 case(s) unscored; a partly measured scorer cannot meet 0.9",
		]);
	});

	test("explains an unmeasured or low check without the unscored note", () => {
		const base = { metric: "x", model: null, pass: false, threshold: 0.5 };
		expect(gateCheckFailure({ ...base, value: null })).toBe(
			"was not measured; it cannot meet 0.5"
		);
		expect(gateCheckFailure({ ...base, value: 0.25 })).toBe(
			"0.25 is below 0.5"
		);
	});
});

describe("the eval-gate entry point", () => {
	test("re-exports the split modules' public API unchanged", () => {
		const expected = [
			"BUILTIN_GATE_METRICS",
			"EvalDatasetError",
			"caseFailures",
			"detectEvalDatasetFormat",
			"escapeXml",
			"evalRunToJunit",
			"evalRunToMarkdown",
			"evalRunToText",
			"evaluateEvalGate",
			"evaluateRedTeamGate",
			"gateTargets",
			"gatewayEvaluatorIds",
			"isBuiltinGateMetric",
			"parseCsv",
			"parseEvalDataset",
			"parseEvalThresholds",
			"parseScorerList",
			"redTeamToJunit",
		];
		expect(Object.keys(facade).sort()).toEqual(expected.sort());
		expect(facade.parseEvalDataset).toBe(datasetModule.parseEvalDataset);
		expect(facade.evalRunToText).toBe(reportModule.evalRunToText);
		expect(facade.evaluateEvalGate).toBe(evaluateEvalGate);
	});
});
