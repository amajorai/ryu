import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "./client.ts";
import { parseActionInputs, validateOperationInputs } from "./input.ts";
import { executeAction } from "./runner.ts";
import type { ActionRuntime } from "./runtime.ts";

const workspace = mkdtempSync(join(tmpdir(), "ryu-action-eval-"));
afterAll(() => {
	rmSync(workspace, { force: true, recursive: true });
});

function runtime(values: Record<string, string>): ActionRuntime & {
	outputs: Map<string, unknown>;
} {
	const outputs = new Map<string, unknown>();
	return {
		exportVariable: () => undefined,
		getInput: (name) => values[name] ?? "",
		info: () => undefined,
		outputs,
		setOutput: (name, value) => outputs.set(name, value),
		setSecret: () => undefined,
		warning: () => undefined,
	};
}

function evalRun(meanOverall: number, toxicity: number) {
	return {
		aggregate: {
			assertion_pass_rate: 1,
			evaluators: {
				toxicity: { executedCount: 1, meanScore: toxicity, passRate: 1 },
			},
			mean_latency: 1,
			mean_overall: meanOverall,
			mean_substring_match: null,
			mean_token_efficiency: 0.5,
			policy_pass_rate: 1,
			total_cases: 1,
		},
		cases: [
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				id: "greeting",
				latency_score: 1,
				overall: meanOverall,
				policy_pass: true,
				prompt: "Say hello",
				response_text: "secret response text",
				substring_match: null,
				token_efficiency: 0.5,
			},
		],
	};
}

function node(
	meanOverall: number,
	toxicity: number,
	sent: { body: unknown; path: string }[]
): FetchLike {
	return async (input, init) => {
		const path = new URL(String(input)).pathname;
		sent.push({
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			path,
		});
		if (path === "/api/health") {
			return Response.json({ status: "ok", version: "0.4.0" });
		}
		if (path === "/api/system/info") {
			return Response.json({ managed: false });
		}
		if (path === "/api/gateway/evaluators") {
			return Response.json({
				evaluators: [
					{
						capabilities: { inline: true, offline: true },
						higherIsBetter: false,
						id: "toxicity",
					},
				],
			});
		}
		return Response.json(evalRun(meanOverall, toxicity));
	};
}

const BASE_INPUTS = {
	agent: "support-agent",
	"eval-dataset": "evals/cases.jsonl",
	"eval-junit-file": "reports/eval.xml",
	"eval-model": "gpt-x",
	"eval-scorers": "toxicity",
	"eval-threshold": "0.8\noverall=0.7",
	"node-url": "https://node.example",
	operation: "eval",
};

describe("eval operation", () => {
	it("replays the dataset, gates thresholds, and writes the reports", async () => {
		const datasetDir = join(workspace, "evals");
		await Bun.write(
			join(datasetDir, "cases.jsonl"),
			'{"id":"greeting","input":"Say hello","expected":"hello"}\n'
		);
		const summaryPath = join(workspace, "summary.md");
		writeFileSync(summaryPath, "");
		const sent: { body: unknown; path: string }[] = [];
		const actionRuntime = runtime(BASE_INPUTS);
		const result = await executeAction({
			environment: { GITHUB_STEP_SUMMARY: summaryPath },
			fetchImpl: node(0.9, 0.1, sent),
			runtime: actionRuntime,
			workingDirectory: workspace,
		});
		expect(sent.map((entry) => entry.path)).toEqual([
			"/api/health",
			"/api/system/info",
			"/api/gateway/evaluators",
			"/api/gateway/evals/run",
		]);
		expect(sent[3]?.body).toEqual({
			agent_id: "support-agent",
			dataset: [{ expected: "hello", id: "greeting", prompt: "Say hello" }],
			evaluators: ["toxicity"],
			model: "gpt-x",
		});
		expect(result.text).toBe("eval passed");
		expect(actionRuntime.outputs.get("eval-passed")).toBe("true");
		const evalJson = JSON.parse(String(actionRuntime.outputs.get("eval-json")));
		expect(evalJson.gate.checks).toEqual([
			{
				metric: "toxicity",
				model: null,
				pass: true,
				threshold: 0.8,
				value: 0.9,
			},
			{
				metric: "overall",
				model: null,
				pass: true,
				threshold: 0.7,
				value: 0.9,
			},
		]);
		const junit = readFileSync(join(workspace, "reports/eval.xml"), "utf8");
		expect(junit).toContain('<testcase classname="ryu.eval" name="greeting"/>');
		const summary = readFileSync(summaryPath, "utf8");
		expect(summary).toContain("## Ryu eval passed");
		expect(summary).toContain("| toxicity | - | 0.9 | 0.8 | pass |");
		expect(summary).not.toContain("secret response text");
	});

	it("fails the job on a regression after writing outputs", async () => {
		const actionRuntime = runtime(BASE_INPUTS);
		const error = await executeAction({
			environment: {},
			fetchImpl: node(0.6, 0.5, []),
			runtime: actionRuntime,
			workingDirectory: workspace,
		}).catch((caught: unknown) => caught);
		expect(String(error)).toContain(
			"Ryu eval gate failed: toxicity 0.5 is below 0.8; overall 0.6 is below 0.7"
		);
		expect(actionRuntime.outputs.get("eval-passed")).toBe("false");
	});

	it("rejects unknown scorers, bad thresholds, and unreadable datasets", async () => {
		const unknownScorer = await executeAction({
			environment: {},
			fetchImpl: node(1, 0, []),
			runtime: runtime({ ...BASE_INPUTS, "eval-scorers": "nope" }),
			workingDirectory: workspace,
		}).catch((caught: unknown) => caught);
		expect(String(unknownScorer)).toContain("unknown evaluator(s): nope");

		expect(() =>
			validateOperationInputs(
				parseActionInputs({
					get: (name) =>
						({ ...BASE_INPUTS, "eval-threshold": "1.5" })[name] ?? "",
				})
			)
		).toThrow("Input 'eval-threshold' is invalid");

		const missing = await executeAction({
			environment: {},
			fetchImpl: node(1, 0, []),
			runtime: runtime({
				...BASE_INPUTS,
				"eval-dataset": "evals/missing.csv",
				"eval-scorers": "",
				"eval-threshold": "",
			}),
			workingDirectory: workspace,
		}).catch((caught: unknown) => caught);
		expect(String(missing)).toContain("Input 'eval-dataset' could not be read");
	});
});
