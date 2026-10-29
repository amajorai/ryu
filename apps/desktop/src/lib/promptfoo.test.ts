import { describe, expect, test } from "bun:test";
import {
	normalizePromptfooConfig,
	parsePromptfooFile,
	serializePromptfooConfig,
	toPromptfooConfig,
} from "./promptfoo.ts";

describe("Promptfoo config normalization", () => {
	test("keeps typed vars, default tests, chat prompts, and assertion options", () => {
		const config = normalizePromptfooConfig({
			defaultTest: {
				vars: { locale: "en" },
				assert: [{ type: "contains", value: "{{answer}}", weight: 2 }],
			},
			prompts: [
				{
					id: "chat",
					messages: [{ role: "user", content: "Hello {{name}}" }],
				},
			],
			providers: [{ id: "openai:gpt-4o" }],
			tests: [{ vars: { name: "Sam", answer: 42 } }],
		});

		expect(config.prompts[0]?.type).toBe("chat");
		expect(config.providers).toEqual(["openai:gpt-4o"]);
		expect(config.tests[0]?.vars).toEqual({
			answer: 42,
			locale: "en",
			name: "Sam",
		});
		expect(config.tests[0]?.assertions[0]).toMatchObject({
			kind: "contains",
			options: { weight: 2 },
		});
	});

	test("parses CSV and exports all supported dataset formats", () => {
		const parsed = parsePromptfooFile(
			'description,prompt,vars,expected\nGreeting,"Hi, {{name}}","{""name"":""Sam""}",hello',
			"cases.csv"
		);
		expect(parsed.format).toBe("csv");
		expect(parsed.config.tests[0]?.vars).toEqual({ name: "Sam" });
		expect(parsed.config.tests[0]?.prompt).toBe("Hi, {{name}}");

		for (const format of ["yaml", "json", "jsonl", "csv"] as const) {
			const output = serializePromptfooConfig(parsed.config, format);
			expect(output.length).toBeGreaterThan(0);
		}
	});

	test("round-trips provider fixtures, case options, nested assertions, and run config", () => {
		const config = normalizePromptfooConfig({
			defaultTest: { vars: { locale: "en" } },
			prompts: ["Answer {{question}}"],
			providers: ["openai:gpt-4o"],
			run_config: { cache: true, max_concurrency: 4, timeout_ms: 30_000 },
			tests: [
				{
					assert: [
						{
							type: "assert-set",
							value: [
								{ type: "contains-html", value: "<p>" },
								{ type: "levenshtein", value: "hello", threshold: 0.8 },
							],
						},
					],
					id: "html-case",
					metadata: { team: "support" },
					options: {
						cache: true,
						prefix: "[test] ",
						transform: "trim",
						transformVars: "json",
					},
					providerOutput: "<p>hello</p>",
					vars: { question: "greeting" },
				},
			],
		});

		expect(config.tests[0]).toMatchObject({
			id: "html-case",
			metadata: { team: "support" },
			providerOutput: "<p>hello</p>",
		});
		expect(config.tests[0]?.assertions[0]).toMatchObject({
			kind: "assert_set",
		});
		const exported = serializePromptfooConfig(config, "yaml");
		expect(exported).toContain("html-case");
		expect(exported).toContain("assert-set");
		expect(exported).toContain("evaluateOptions");
	});

	test("preserves Promptfoo assertion negation", () => {
		const config = normalizePromptfooConfig({
			tests: [
				{
					assert: [{ not: true, type: "contains", value: "secret" }],
				},
			],
		});
		expect(config.tests[0]?.assertions[0]).toMatchObject({
			kind: "contains",
			options: { not: true },
		});
		expect(serializePromptfooConfig(config, "json")).toContain(
			'"type": "not-contains"'
		);

		const prefixed = normalizePromptfooConfig({
			tests: [{ assert: [{ type: "not-regex", value: "secret" }] }],
		});
		expect(prefixed.tests[0]?.assertions[0]).toMatchObject({
			kind: "regex",
			options: { not: true },
		});
	});

	test("keeps editor assertion options and named text-variant identity in JSON exports", () => {
		const config = normalizePromptfooConfig({
			prompts: [
				{ content: "Answer {{question}}", id: "primary", name: "Primary" },
				{ content: "Be brief.", id: "compact", name: "Compact" },
			],
			tests: [
				{
					assertions: [
						{
							kind: "contains",
							options: {
								not: true,
								provider: "judge-fixture",
								threshold: 0.75,
								transform: "trim",
								weight: 2,
							},
							value: "secret",
						},
					],
				},
			],
		});
		const exported = toPromptfooConfig(config);

		expect(config.prompts[0]?.content).toBe("Answer {{question}}");
		expect(
			toPromptfooConfig({ ...config, prompts: [config.prompts[1]!] }).prompts
		).toMatchObject([
			{
				content: "Be brief.",
				id: "compact",
				name: "Compact",
			},
		]);
		expect(exported.tests).toMatchObject([
			{
				assert: [
					{
						type: "not-contains",
						provider: "judge-fixture",
						threshold: 0.75,
						transform: "trim",
						weight: 2,
					},
				],
			},
		]);
	});

	test("resolves selected file-backed prompts and datasets into owned content", () => {
		const parsed = parsePromptfooFile(
			JSON.stringify({
				prompts: ["file://prompts/answer.j2"],
				tests: "file://datasets/cases.jsonl",
			}),
			"suite.json",
			{
				"cases.jsonl":
					'{"id":"case-1","prompt":"Hello {{name}}","vars":{"name":"Sam"}}',
				"answer.j2": "Answer {{name}} clearly.",
			}
		);
		expect(parsed.config.prompts[0]?.content).toBe("Answer {{name}} clearly.");
		expect(parsed.config.tests[0]).toMatchObject({
			id: "case-1",
			prompt: "Hello {{name}}",
		});
	});

	test("supports an explicit per-case default-test opt out", () => {
		const config = normalizePromptfooConfig({
			defaultTest: { assert: [{ type: "contains", value: "baseline" }] },
			tests: [
				{ id: "inherits", prompt: "one" },
				{ defaultTest: false, id: "skips", prompt: "two" },
			],
		});
		expect(config.tests[0]?.assertions).toHaveLength(1);
		expect(config.tests[1]?.assertions).toHaveLength(0);
	});

	test("accepts Promptfoo targets and file-backed default tests", () => {
		const parsed = parsePromptfooFile(
			JSON.stringify({
				defaultTest: "file://defaults.yaml",
				prompts: ["Answer {{question}}"],
				targets: [{ id: "openai:gpt-4o-mini" }],
				tests: [{ vars: { question: "2+2" } }],
			}),
			"suite.json",
			{
				"defaults.yaml": "assert:\n  - type: contains\n    value: 4\n",
			}
		);
		expect(parsed.config.providers).toEqual(["openai:gpt-4o-mini"]);
		expect(parsed.config.tests[0]?.assertions[0]).toMatchObject({
			kind: "contains",
			value: "4",
		});
		const exported = serializePromptfooConfig(parsed.config, "json");
		expect(exported).toContain('"providers"');
		expect(exported).not.toContain('"targets"');
	});
});

describe("Promptfoo imported document boundaries", () => {
	test("preserves additive document fields and hostile own JSON keys", () => {
		const config = parsePromptfooFile(
			'{"__proto__":{"owned":true},"extra":{"flag":true},"tests":[{"vars":{"__proto__":"literal","name":"Sam"},"context":[1,null],"provider_output":{"answer":42}}]}',
			"suite.json"
		).config;
		expect(Object.hasOwn(config, "__proto__")).toBe(true);
		expect(config.extra).toEqual({ flag: true });
		expect(Object.hasOwn(config.tests[0]?.vars ?? {}, "__proto__")).toBe(true);
		expect(config.tests[0]?.context).toEqual([1, null]);
		expect(config.tests[0]?.providerOutput).toEqual({ answer: 42 });
		expect({}).not.toHaveProperty("owned");
	});
	test("retains YAML non-finite numeric assertion values and thresholds", () => {
		const config = parsePromptfooFile(
			"tests:\n  - threshold: .inf\n    assert:\n      - type: equals\n        value: .nan\n",
			"suite.yaml"
		).config;
		expect(config.tests[0]?.threshold).toBe(Number.POSITIVE_INFINITY);
		expect(config.tests[0]?.assertions[0]).toEqual({
			kind: "equals",
			value: "NaN",
		});
	});
	test("keeps per-field fallback behavior and assertion option precedence", () => {
		const config = normalizePromptfooConfig({
			tests: [
				{
					providers: [null, 12, "fixture"],
					messages: [
						null,
						{ role: "tool", content: "ignored" },
						{ role: 12, content: false },
					],
					assert: [
						{
							type: "not-regex",
							value: ["one", 2, null],
							options: { threshold: 0.2, not: false, rubricPrompt: "nested" },
							threshold: 0.8,
							not: true,
							rubric_prompt: "outer",
						},
					],
				},
			],
		});
		expect(config.tests[0]?.providers).toEqual(["fixture"]);
		expect(config.tests[0]?.messages).toEqual([{ role: "user", content: "" }]);
		expect(config.tests[0]?.assertions).toEqual([
			{
				kind: "regex",
				value: "one,2,null",
				options: { threshold: 0.8, not: true, rubric_prompt: "outer" },
			},
		]);
	});
	test("rejects values that cannot come from a Promptfoo JSON or YAML document", () => {
		expect(() =>
			normalizePromptfooConfig({ tests: [], callback: () => true })
		).toThrow();
	});
});
