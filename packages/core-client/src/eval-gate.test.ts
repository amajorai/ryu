import { describe, expect, test } from "bun:test";
import {
	caseFailures,
	detectEvalDatasetFormat,
	EvalDatasetError,
	evalRunToJunit,
	evalRunToMarkdown,
	evaluateEvalGate,
	evaluateRedTeamGate,
	gatewayEvaluatorIds,
	parseCsv,
	parseEvalDataset,
	parseEvalThresholds,
	parseScorerList,
	redTeamToJunit,
} from "./eval-gate.ts";
import type { EvalCaseScore, EvalRunResult } from "./gateway.ts";

const BYTE_ORDER_MARK = String.fromCharCode(0xfe_ff);

function caseScore(overrides: Partial<EvalCaseScore> = {}): EvalCaseScore {
	return {
		assertion_score: 1,
		assertions: [],
		assertions_pass: true,
		latency_score: 1,
		overall: 0.9,
		policy_pass: true,
		prompt: "What is 2+2?",
		response_text: "4",
		substring_match: null,
		token_efficiency: 0.5,
		...overrides,
	};
}

function run(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
	return {
		aggregate: {
			assertion_pass_rate: 0.5,
			evaluators: {
				answer_relevance: { executedCount: 2, meanScore: 0.85, passRate: 1 },
				toxicity: { executedCount: 2, meanScore: 0.1, passRate: 1 },
			},
			mean_latency: 1,
			mean_overall: 0.72,
			mean_substring_match: null,
			mean_token_efficiency: 0.5,
			policy_pass_rate: 1,
			total_cases: 2,
		},
		cases: [
			caseScore({ id: "math" }),
			caseScore({
				assertion_score: 0,
				assertions: [
					{
						detail: "missing 'Paris'",
						executed: true,
						kind: "contains",
						pass: false,
						score: 0,
					},
				],
				assertions_pass: false,
				prompt: "Capital of France?",
				response_text: "Lyon",
			}),
		],
		...overrides,
	};
}

describe("datasets", () => {
	test("detects formats from the file name and the content", () => {
		expect(detectEvalDatasetFormat("", "cases.JSONL")).toBe("jsonl");
		expect(detectEvalDatasetFormat("", "a.ndjson")).toBe("jsonl");
		expect(detectEvalDatasetFormat("", "a.csv")).toBe("csv");
		expect(detectEvalDatasetFormat('[{"prompt":"x"}]')).toBe("json");
		expect(detectEvalDatasetFormat('{"cases":[]}')).toBe("json");
		expect(detectEvalDatasetFormat('{"prompt":"a"}\n{"prompt":"b"}')).toBe(
			"jsonl"
		);
		expect(detectEvalDatasetFormat("prompt,expected\nhi,hello")).toBe("csv");
	});

	test("parses quoted CSV with embedded commas, quotes, and newlines", () => {
		expect(
			parseCsv(`${BYTE_ORDER_MARK}a,b\r\n"x, y","say ""hi""\nthere"\n\n1,\n`)
		).toEqual([
			["a", "b"],
			["x, y", 'say "hi"\nthere'],
			["1", ""],
		]);
		expect(() => parseCsv('a\n"unterminated')).toThrow(EvalDatasetError);
	});

	test("maps CSV columns to Gateway cases and keeps extras as vars", () => {
		const cases = parseEvalDataset(
			'id,input,expected_output,context,topic\nq1,What is {{topic}}?,blue,"[""sky""]",sky\n',
			{ fileName: "set.csv" }
		);
		expect(cases).toEqual([
			{
				context: ["sky"],
				expected: "blue",
				id: "q1",
				prompt: "What is {{topic}}?",
				vars: { topic: "sky" },
			},
		]);
	});

	test("accepts JSON arrays, envelopes, and JSONL with Gateway fields", () => {
		const fromArray = parseEvalDataset(
			JSON.stringify([
				{
					assertions: [{ kind: "contains", value: "4" }],
					evaluators: ["answer_relevance"],
					expected: 4,
					prompt: "2+2?",
					threshold: 0.5,
				},
			])
		);
		expect(fromArray[0]).toEqual({
			assertions: [{ kind: "contains", value: "4" }],
			evaluators: ["answer_relevance"],
			expected: "4",
			prompt: "2+2?",
			threshold: 0.5,
		});
		const fromEnvelope = parseEvalDataset(
			JSON.stringify({ cases: [{ question: "Why?" }] })
		);
		expect(fromEnvelope).toEqual([{ prompt: "Why?" }]);
		// The SDK's `{ name, items }` envelope loads unchanged.
		expect(
			parseEvalDataset(
				JSON.stringify({
					items: [{ expected: "4", id: "math", input: "2+2?" }],
					name: "smoke",
				})
			)
		).toEqual([{ expected: "4", id: "math", prompt: "2+2?" }]);
		const fromLines = parseEvalDataset(
			'{"prompt":"a"}\n\n{"messages":[{"role":"user","content":"hi"}]}\n',
			{ format: "jsonl" }
		);
		expect(fromLines[1]).toEqual({
			messages: [{ content: "hi", role: "user" }],
			prompt: "",
		});
	});

	test("rejects empty datasets, missing prompts, and bad fields with the row", () => {
		expect(() => parseEvalDataset("[]")).toThrow("dataset has no cases");
		expect(() => parseEvalDataset('[{"expected":"x"}]')).toThrow(
			"case 1 needs a prompt"
		);
		expect(() =>
			parseEvalDataset('[{"prompt":"x","assertions":[{"kind":"nope"}]}]')
		).toThrow("case 1 field");
		expect(() => parseEvalDataset('{"prompt":"a"}\nnot json')).toThrow(
			"JSONL line 2"
		);
		expect(() => parseEvalDataset("a,b\n1,2,3", { format: "csv" })).toThrow(
			"CSV row 2"
		);
	});
});

describe("thresholds", () => {
	test("parses bare and per-scorer thresholds, including lists", () => {
		expect(parseEvalThresholds(["0.8", "toxicity=0.95, overall=0.7"])).toEqual({
			defaultMin: 0.8,
			perMetric: { overall: 0.7, toxicity: 0.95 },
		});
		expect(() => parseEvalThresholds(["1.5"])).toThrow("between 0 and 1");
		expect(() => parseEvalThresholds(["=0.5"])).toThrow("names no scorer");
		expect(() => parseEvalThresholds(["x="])).toThrow("between 0 and 1");
	});

	test("derives the Gateway evaluator ids from scorers and thresholds", () => {
		const thresholds = parseEvalThresholds(["toxicity=0.9", "overall=0.5"]);
		expect(
			gatewayEvaluatorIds(
				parseScorerList(["answer_relevance,assertions", "answer_relevance"]),
				thresholds
			)
		).toEqual(["answer_relevance", "toxicity"]);
	});
});

describe("gate", () => {
	test("a bare threshold gates overall when no scorer is named", () => {
		const report = evaluateEvalGate(run(), {
			scorers: [],
			thresholds: parseEvalThresholds(["0.8"]),
		});
		expect(report.ok).toBe(false);
		expect(report.failures).toEqual(["overall 0.72 is below 0.8"]);
	});

	test("inverts lower-is-better evaluators and gates each scorer", () => {
		const report = evaluateEvalGate(run(), {
			lowerIsBetter: new Set(["toxicity"]),
			scorers: ["answer_relevance", "toxicity"],
			thresholds: parseEvalThresholds(["0.8", "assertions=0.5"]),
		});
		expect(report.ok).toBe(true);
		expect(report.checks.map((check) => [check.metric, check.value])).toEqual([
			["answer_relevance", 0.85],
			["toxicity", 0.9],
			["assertions", 0.5],
		]);
	});

	test("an unmeasured metric fails instead of passing silently", () => {
		const report = evaluateEvalGate(run(), {
			scorers: [],
			thresholds: parseEvalThresholds(["hallucination=0.5", "substring=0.1"]),
		});
		expect(report.failures).toEqual([
			"hallucination was not measured; it cannot meet 0.5",
			"substring was not measured; it cannot meet 0.1",
		]);
	});

	test("checks every model of a multi-model run", () => {
		const base = run();
		const report = evaluateEvalGate(
			run({
				models: [
					{ aggregate: base.aggregate, cases: base.cases, model: "a" },
					{
						aggregate: { ...base.aggregate, mean_overall: 0.95 },
						cases: base.cases,
						model: "b",
					},
				],
			}),
			{ scorers: [], thresholds: parseEvalThresholds(["overall=0.9"]) }
		);
		expect(report.failures).toEqual(["overall (a) 0.72 is below 0.9"]);
		expect(report.checks).toHaveLength(2);
	});

	test("errored cases fail a gated run even when the aggregates look clean", () => {
		const base = run();
		const report = evaluateEvalGate(
			run({
				cases: [caseScore({ error: "provider down", id: "a" }), caseScore()],
				aggregate: { ...base.aggregate, mean_overall: 1 },
			}),
			{ scorers: [], thresholds: parseEvalThresholds(["overall=0.5"]) }
		);
		expect(report.ok).toBe(false);
		expect(report.failures).toEqual([
			"1 of 2 case(s) errored; a run with errored cases cannot pass",
		]);
	});

	test("no thresholds means nothing is gated", () => {
		const report = evaluateEvalGate(run(), {
			scorers: ["toxicity"],
			thresholds: parseEvalThresholds([]),
		});
		expect(report).toEqual({ checks: [], failures: [], ok: true });
	});

	test("red-team gate compares needs_attention to the maximum", () => {
		expect(
			evaluateRedTeamGate(
				{ summary: { needs_attention: 1, protected: 4, total: 5 } },
				0
			).failures
		).toEqual(["1 probe(s) need attention (maximum 0)"]);
		expect(
			evaluateRedTeamGate(
				{ summary: { needs_attention: 1, protected: 4, total: 5 } },
				1
			).ok
		).toBe(true);
		expect(evaluateRedTeamGate({}, 0).failures).toEqual([
			"red-team result has no summary",
		]);
	});
});

describe("reports", () => {
	test("case failures list errors, assertions, and failing evaluators", () => {
		expect(
			caseFailures(
				caseScore({
					error: "timeout",
					evaluators: [
						{
							category: "quality",
							detail: "off topic",
							executed: true,
							id: "answer_relevance",
							pass: false,
							score: 0.2,
						},
						{
							category: "quality",
							detail: "skipped",
							executed: false,
							id: "tone",
							pass: false,
							score: 0,
						},
					],
				})
			)
		).toEqual(["error: timeout", "answer_relevance: off topic"]);
	});

	test("JUnit XML has one testcase per case plus the gate, escaped", () => {
		const result = run();
		const report = evaluateEvalGate(result, {
			scorers: [],
			thresholds: parseEvalThresholds(["0.8"]),
		});
		const xml = evalRunToJunit(result, report);
		expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
		expect(xml).toContain('<testsuite name="ryu.eval" tests="2" failures="1">');
		expect(xml).toContain('<testcase classname="ryu.eval" name="math"/>');
		expect(xml).toContain(
			'<failure message="contains: missing &apos;Paris&apos;">'
		);
		expect(xml).toContain(
			'<testsuite name="ryu.eval.gate" tests="1" failures="1">'
		);
		expect(xml).toContain('name="overall &gt;= 0.8"');
	});

	test("red-team JUnit marks unprotected probes as failures", () => {
		const xml = redTeamToJunit(
			{
				strategies: [
					{
						detail: "ok",
						evaluator: "prompt_injection",
						id: "pi",
						name: "Prompt injection",
						protected: true,
					},
					{
						detail: "leaked <ssn>",
						evaluator: "pii_leakage",
						id: "pii",
						name: "PII",
						protected: false,
					},
				],
				summary: { needs_attention: 1, protected: 1, total: 2 },
			},
			evaluateRedTeamGate(
				{ summary: { needs_attention: 1, protected: 1, total: 2 } },
				0
			)
		);
		expect(xml).toContain('tests="2" failures="1"');
		expect(xml).toContain("leaked &lt;ssn&gt;");
	});

	test("Markdown summary tabulates checks and failing cases without responses", () => {
		const result = run();
		const markdown = evalRunToMarkdown(
			result,
			evaluateEvalGate(result, {
				scorers: [],
				thresholds: parseEvalThresholds(["0.8"]),
			})
		);
		expect(markdown).toContain("## Ryu eval failed");
		expect(markdown).toContain("| overall | - | 0.72 | 0.8 | FAIL |");
		expect(markdown).toContain("### Failing cases (1)");
		expect(markdown).not.toContain("Lyon");
	});

	test("Markdown summary neutralizes HTML and Markdown in case text", () => {
		const base = run();
		const failing = base.cases.find((score) => caseFailures(score).length > 0);
		if (!failing) {
			throw new Error("fixture has no failing case");
		}
		const result = {
			...base,
			cases: [
				{
					...failing,
					error:
						"<img src=x onerror=alert(1)> [click](https://evil.test) `x` a|b",
					id: "case_<b>*1*</b>",
				},
			],
		};
		const markdown = evalRunToMarkdown(result, {
			checks: [],
			failures: [],
			ok: true,
		});
		expect(markdown).not.toContain("<img");
		expect(markdown).not.toContain("<b>");
		expect(markdown).not.toMatch(/(^|[^\\])\[click\]/);
		expect(markdown).not.toContain("`x`");
		expect(markdown).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(markdown).toContain("a\\|b");
		expect(markdown).toContain("case\\_&lt;b&gt;\\*1\\*&lt;/b&gt;");
	});
});
