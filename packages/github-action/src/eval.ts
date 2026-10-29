import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	type EvalGateReport,
	evalRunToJunit,
	evalRunToMarkdown,
	evaluateEvalGate,
	gateTargets,
	gatewayEvaluatorIds,
	parseEvalDataset,
	parseEvalThresholds,
} from "@ryuhq/core-client/eval-gate";
import {
	type EvalDatasetCase,
	type EvalRunResult,
	gatewayEvalRunSchema,
	type RunEvalsRequest,
} from "@ryuhq/core-client/gateway";
import { z } from "zod";
import type { RyuNodeClient } from "./client.ts";
import type { ActionInputs } from "./types.ts";

/** The eval operation's outcome: the Gateway run plus the threshold gate. */
export interface EvalOperationResult {
	gate: EvalGateReport;
	run: EvalRunResult;
}

const catalogSchema = z.object({
	evaluators: z.array(
		z.looseObject({
			capabilities: z.looseObject({ offline: z.boolean() }).optional(),
			higherIsBetter: z.boolean().optional(),
			id: z.string(),
		})
	),
});

async function negativeSignalEvaluators(
	client: RyuNodeClient,
	ids: readonly string[],
	timeoutMs: number
): Promise<Set<string>> {
	const lowerIsBetter = new Set<string>();
	if (ids.length === 0) {
		return lowerIsBetter;
	}
	const parsed = catalogSchema.safeParse(await client.evaluators(timeoutMs));
	if (!parsed.success) {
		throw new Error("The node returned an unexpected evaluator catalog.");
	}
	const offline = new Map(
		parsed.data.evaluators
			.filter((entry) => entry.capabilities?.offline !== false)
			.map((entry) => [entry.id, entry])
	);
	const unknown = ids.filter((id) => !offline.has(id));
	if (unknown.length > 0) {
		throw new Error(
			`Input 'eval-scorers' names unknown evaluator(s): ${unknown.join(", ")}. Offline evaluators: ${[...offline.keys()].join(", ")}.`
		);
	}
	for (const id of ids) {
		if (offline.get(id)?.higherIsBetter === false) {
			lowerIsBetter.add(id);
		}
	}
	return lowerIsBetter;
}

async function readDataset(
	path: string,
	workingDirectory: string
): Promise<EvalDatasetCase[]> {
	const absolute = resolve(workingDirectory, path);
	let text: string;
	try {
		text = await readFile(absolute, "utf8");
	} catch (error) {
		throw new Error(
			`Input 'eval-dataset' could not be read (${path}): ${error instanceof Error ? error.message : String(error)}`
		);
	}
	try {
		return parseEvalDataset(text, { fileName: basename(absolute) });
	} catch (error) {
		throw new Error(
			`Input 'eval-dataset' is invalid (${path}): ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Run the `eval` operation: replay the dataset through Core's Gateway eval
 * proxy, compare the aggregates against `eval-threshold`, and write the JUnit
 * report when asked. Throwing is left to the runner so outputs and the step
 * summary are written before the job fails.
 */
export async function runEvalOperation(
	client: RyuNodeClient,
	inputs: ActionInputs,
	workingDirectory: string
): Promise<EvalOperationResult> {
	const thresholds = parseEvalThresholds(inputs.evalThresholds);
	const scorers = inputs.evalScorers;
	const evaluatorIds = gatewayEvaluatorIds(scorers, thresholds);
	const lowerIsBetter = await negativeSignalEvaluators(
		client,
		evaluatorIds,
		inputs.timeoutMs
	);
	const body: RunEvalsRequest = { agent_id: inputs.agent };
	if (inputs.evalModel) {
		body.model = inputs.evalModel;
	}
	if (inputs.evalJudgeModel) {
		body.judge_model = inputs.evalJudgeModel;
	}
	if (inputs.evalDataset) {
		body.dataset = await readDataset(inputs.evalDataset, workingDirectory);
	}
	if (evaluatorIds.length > 0) {
		body.evaluators = evaluatorIds;
	}
	const parsed = gatewayEvalRunSchema.safeParse(
		await client.runEvals(body, inputs.timeoutMs)
	);
	if (!parsed.success) {
		throw new Error("The node returned an unexpected eval result.");
	}
	const run = parsed.data;
	const gate =
		gateTargets(scorers, thresholds).size > 0
			? evaluateEvalGate(run, { lowerIsBetter, scorers, thresholds })
			: { checks: [], failures: [], ok: true };
	if (inputs.evalJunitFile) {
		const output = resolve(workingDirectory, inputs.evalJunitFile);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, evalRunToJunit(run, gate), "utf8");
	}
	return { gate, run };
}

/** Markdown for the step summary (scores and failing case names only). */
export function evalSummary(result: EvalOperationResult): string {
	return evalRunToMarkdown(result.run, result.gate);
}
