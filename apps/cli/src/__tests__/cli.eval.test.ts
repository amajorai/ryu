// `ryu eval` / `ryu redteam` CI gating: dataset files, scorer/threshold flags,
// JSON/JUnit output, and the non-zero exit below a threshold. Core is mocked
// through the injected CoreApi seam, so nothing reaches a node.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import { parseEvalFlags, withoutActionToken } from "../cli/evalCommands.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

type CoreCall = NonNullable<CoreApi["call"]>;
interface Captured {
	body?: unknown;
	method?: string;
	path: string;
}

let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "ryu-cli-eval-"));
});

afterAll(() => {
	rmSync(scratch, { force: true, recursive: true });
});

function makeIo() {
	let out = "";
	let err = "";
	const io: CliIO = {
		err: (s) => {
			err += s;
		},
		out: (s) => {
			out += s;
		},
	};
	return { err: () => err, io, out: () => out };
}

function stubApi(call: CoreCall): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		call,
		disableApp: notCalled,
		enableApp: notCalled,
		execAppCommand: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		streamChat: notCalled,
		uninstallApp: notCalled,
	};
}

const CATALOG = {
	evaluators: [
		{
			capabilities: { inline: false, offline: true },
			higherIsBetter: true,
			id: "answer_relevance",
		},
		{
			capabilities: { inline: true, offline: true },
			higherIsBetter: false,
			id: "toxicity",
		},
		{
			capabilities: { inline: true, offline: false },
			higherIsBetter: true,
			id: "inline_only",
		},
	],
};

function evalResult(meanOverall: number) {
	return {
		aggregate: {
			assertion_pass_rate: 1,
			evaluators: {
				answer_relevance: { executedCount: 1, meanScore: 0.9, passRate: 1 },
				toxicity: { executedCount: 1, meanScore: 0.2, passRate: 1 },
			},
			mean_latency: 1,
			mean_overall: meanOverall,
			mean_substring_match: 1,
			mean_token_efficiency: 0.5,
			policy_pass_rate: 1,
			total_cases: 1,
		},
		cases: [
			{
				assertion_score: 1,
				assertions: [],
				assertions_pass: true,
				id: "q1",
				latency_score: 1,
				overall: meanOverall,
				policy_pass: true,
				prompt: "Capital of France?",
				response_text: "Paris",
				substring_match: 1,
				token_efficiency: 0.5,
			},
		],
	};
}

function recordingApi(meanOverall: number, calls: Captured[]): CoreApi {
	return stubApi((_target, path, options) => {
		calls.push({ body: options?.body, method: options?.method, path });
		if (path === "/api/gateway/evaluators") {
			return Promise.resolve(CATALOG);
		}
		return Promise.resolve(evalResult(meanOverall));
	});
}

test("parseEvalFlags consumes eval flag values and skips global value flags", () => {
	const flags = parseEvalFlags([
		"agent-1",
		"--node",
		"http://node:7980",
		"--dataset=cases.csv",
		"-s",
		"toxicity",
		"--scorer",
		"answer_relevance",
		"--threshold",
		"0.8",
		"-t",
		"toxicity=0.9",
		"gpt-x",
		"--junit",
		"--concurrency",
		"4",
	]);
	expect(flags).toMatchObject({
		concurrency: 4,
		dataset: "cases.csv",
		junit: true,
		positional: ["agent-1", "gpt-x"],
		scorers: ["toxicity", "answer_relevance"],
		thresholds: ["0.8", "toxicity=0.9"],
	});
	expect(() => parseEvalFlags(["--threshold"])).toThrow("needs a value");
	expect(() => parseEvalFlags(["--json", "--junit"])).toThrow("not both");
	expect(() => parseEvalFlags(["--bogus"])).toThrow("Unknown flag --bogus");
	expect(() => parseEvalFlags(["--concurrency", "0"])).toThrow("at least 1");
});

test("eval: sends the dataset file and scorers, and passes above threshold", async () => {
	const datasetPath = join(scratch, "cases.csv");
	writeFileSync(
		datasetPath,
		"id,prompt,expected,topic\nq1,Capital of {{topic}}?,Paris,France\n"
	);
	const calls: Captured[] = [];
	const cap = makeIo();
	const code = await runCli(
		[
			"eval",
			"agent-1",
			"gpt-x",
			"--dataset",
			datasetPath,
			"--scorer",
			"answer_relevance,toxicity",
			"--threshold",
			"0.75",
			"--json",
		],
		{ api: recordingApi(0.9, calls), io: cap.io }
	);
	expect(cap.err()).toBe("");
	expect(code).toBe(0);
	expect(calls.map((call) => call.path)).toEqual([
		"/api/gateway/evaluators",
		"/api/gateway/evals/run",
	]);
	expect(calls[1]?.body).toEqual({
		agent_id: "agent-1",
		dataset: [
			{
				expected: "Paris",
				id: "q1",
				prompt: "Capital of {{topic}}?",
				vars: { topic: "France" },
			},
		],
		evaluators: ["answer_relevance", "toxicity"],
		model: "gpt-x",
	});
	const output = JSON.parse(cap.out());
	expect(output.aggregate.mean_overall).toBe(0.9);
	expect(output.gate.ok).toBe(true);
	// toxicity's raw 0.2 is a bad-signal score; the gate compares 1 - 0.2.
	expect(
		output.gate.checks.map((check: { metric: string; value: number }) => [
			check.metric,
			check.value,
		])
	).toEqual([
		["answer_relevance", 0.9],
		["toxicity", 0.8],
	]);
});

test("eval: exits non-zero with a reason when a threshold is missed", async () => {
	const calls: Captured[] = [];
	const cap = makeIo();
	const code = await runCli(["eval", "agent-1", "--threshold", "0.8"], {
		api: recordingApi(0.5, calls),
		io: cap.io,
	});
	expect(code).toBe(1);
	expect(calls.map((call) => call.path)).toEqual(["/api/gateway/evals/run"]);
	expect(cap.out()).toContain("FAIL gate overall: 0.5 >= 0.8");
	expect(cap.err()).toContain("overall 0.5 is below 0.8");
});

test("eval: without thresholds it reports and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["eval"], {
		api: recordingApi(0.1, []),
		io: cap.io,
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("cases 1 · mean overall 0.1");
});

test("eval: --junit writes JUnit XML including the gate suite", async () => {
	const cap = makeIo();
	const code = await runCli(
		["eval", "agent-1", "--threshold", "overall=0.95", "--junit"],
		{ api: recordingApi(0.9, []), io: cap.io }
	);
	expect(code).toBe(1);
	expect(cap.out()).toContain('<testcase classname="ryu.eval" name="q1"/>');
	expect(cap.out()).toContain(
		'<testsuite name="ryu.eval.gate" tests="1" failures="1">'
	);
});

test("eval: rejects unknown or inline-only scorers before running", async () => {
	const calls: Captured[] = [];
	const cap = makeIo();
	const code = await runCli(
		["eval", "--scorer", "inline_only", "--threshold", "0.5"],
		{ api: recordingApi(0.9, calls), io: cap.io }
	);
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown scorer inline_only");
	expect(calls.map((call) => call.path)).toEqual(["/api/gateway/evaluators"]);
});

test("eval: a bad dataset or threshold is a usage error", async () => {
	const badPath = join(scratch, "bad.jsonl");
	writeFileSync(badPath, '{"expected":"x"}\n');
	const datasetIo = makeIo();
	expect(
		await runCli(["eval", "--dataset", badPath], {
			api: recordingApi(1, []),
			io: datasetIo.io,
		})
	).toBe(2);
	expect(datasetIo.err()).toContain("case 1 needs a prompt");
	const thresholdIo = makeIo();
	expect(
		await runCli(["eval", "--threshold", "2"], {
			api: recordingApi(1, []),
			io: thresholdIo.io,
		})
	).toBe(2);
	expect(thresholdIo.err()).toContain("between 0 and 1");
});

test("observability eval delegates with the same flags", async () => {
	const calls: Captured[] = [];
	const cap = makeIo();
	const code = await runCli(
		["observability", "eval", "agent-1", "--threshold", "0.95"],
		{ api: recordingApi(0.9, calls), io: cap.io }
	);
	expect(code).toBe(1);
	expect(calls[0]?.body).toEqual({ agent_id: "agent-1" });
});

test("withoutActionToken drops the action, never a flag value", () => {
	expect(withoutActionToken(["eval", "agent-1", "-t", "0.9"], "eval")).toEqual([
		"agent-1",
		"-t",
		"0.9",
	]);
	expect(
		withoutActionToken(["--model", "eval", "eval", "agent-1"], "eval")
	).toEqual(["--model", "eval", "agent-1"]);
	expect(withoutActionToken(["--json", "eval"], "eval")).toEqual(["--json"]);
	expect(withoutActionToken(["agent-1"], "eval")).toEqual(["agent-1"]);
});

test("redteam: --max-attention gates the campaign", async () => {
	const campaign = {
		campaign_id: "c1",
		model: "gpt-x",
		strategies: [
			{
				detail: "leaked",
				evaluator: "pii_leakage",
				id: "pii",
				name: "PII",
				protected: false,
			},
		],
		summary: { needs_attention: 1, protected: 0, total: 1 },
	};
	const api = stubApi(() => Promise.resolve(campaign));
	const failing = makeIo();
	expect(
		await runCli(["redteam", "agent-1", "--max-attention", "0"], {
			api,
			io: failing.io,
		})
	).toBe(1);
	expect(JSON.parse(failing.out()).gate.ok).toBe(false);
	expect(failing.err()).toContain("1 probe(s) need attention (maximum 0)");

	const tolerant = makeIo();
	expect(
		await runCli(["redteam", "agent-1", "--max-attention", "1", "--junit"], {
			api,
			io: tolerant.io,
		})
	).toBe(0);
	expect(tolerant.out()).toContain('tests="1" failures="1"');

	const ungated = makeIo();
	expect(await runCli(["redteam", "agent-1"], { api, io: ungated.io })).toBe(0);
	expect(JSON.parse(ungated.out())).toEqual(campaign);
});
