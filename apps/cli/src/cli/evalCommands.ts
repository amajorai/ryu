// `ryu-cli eval` and `ryu-cli redteam`: run the Gateway's eval dataset / security probes
// through Core and, when asked, gate CI on the result.
//
// Endpoint map (pre-existing Core proxies to the Gateway):
//   eval      POST /api/gateway/evals/run     (dataset replay + scoring)
//             GET  /api/gateway/evaluators    (catalog polarity for thresholds)
//   redteam   POST /api/gateway/redteam/run   (bounded local probe campaign)
//
// The dataset parsing, threshold comparison, and JUnit/text rendering live in
// `@ryuhq/core-client/eval-gate` so the GitHub Action gates identically.
//
// These commands read their own flags from `ctx.rawArgs`: the global parser
// ignores unknown `--flags` but would leave their VALUES behind as positional
// args (`--dataset cases.csv` → agent id `cases.csv`), so every eval flag is
// consumed here instead.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	BUILTIN_GATE_METRICS,
	type EvalGateReport,
	type EvalThresholds,
	evalRunToJunit,
	evalRunToText,
	evaluateEvalGate,
	evaluateRedTeamGate,
	gateTargets,
	gatewayEvaluatorIds,
	parseEvalDataset,
	parseEvalThresholds,
	parseScorerList,
	type RedTeamGateInput,
	redTeamToJunit,
} from "@ryuhq/core-client/eval-gate";
import {
	type EvalDatasetCase,
	type EvalRunResult,
	gatewayEvalRunSchema,
} from "@ryuhq/core-client/gateway";
import { z } from "zod";
import { tr } from "../i18n/translate.ts";
import {
	EVAL_USAGE,
	type EvalFlags,
	parseEvalFlags,
	REDTEAM_USAGE,
} from "./evalFlags.ts";
import { localize } from "./localizedText.ts";
import { type CliContext, type Command, UsageError } from "./types.ts";

export type { EvalFlags } from "./evalFlags.ts";
export { parseEvalFlags, withoutActionToken } from "./evalFlags.ts";

async function coreJson(
	ctx: CliContext,
	path: string,
	options: { body?: unknown; method?: string } = {}
): Promise<unknown> {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	return ctx.api.call(ctx.target, path, {
		method: options.method ?? "POST",
		body: options.body,
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadDataset(path: string): Promise<EvalDatasetCase[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new UsageError(
			localize("Cannot read dataset {path}: {message}", {
				message: errorText(error),
				path,
			})
		);
	}
	try {
		return parseEvalDataset(text, { fileName: basename(path) });
	} catch (error) {
		throw new UsageError(
			localize("Invalid dataset {path}: {message}", {
				message: errorText(error),
				path,
			})
		);
	}
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

/**
 * Resolve requested evaluator ids against the Gateway catalog: unknown or
 * inline-only ids are a usage error (with the valid ids), and the returned set
 * holds the negative-signal evaluators whose scores the gate inverts.
 */
async function resolveEvaluatorPolarity(
	ctx: CliContext,
	ids: readonly string[]
): Promise<Set<string>> {
	const lowerIsBetter = new Set<string>();
	if (ids.length === 0) {
		return lowerIsBetter;
	}
	const parsed = catalogSchema.safeParse(
		await coreJson(ctx, "/api/gateway/evaluators", { method: "GET" })
	);
	if (!parsed.success) {
		throw new Error("Gateway returned an unexpected evaluator catalog");
	}
	const offline = parsed.data.evaluators.filter(
		(entry) => entry.capabilities?.offline !== false
	);
	const known = new Map(offline.map((entry) => [entry.id, entry]));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		throw new UsageError(
			localize(
				"Unknown scorer {scorers}. Use a built-in metric ({metrics}) or an offline evaluator id: {evaluators}",
				{
					evaluators: [...known.keys()].join(", "),
					metrics: Object.keys(BUILTIN_GATE_METRICS).join(", "),
					scorers: unknown.join(", "),
				}
			)
		);
	}
	for (const id of ids) {
		if (known.get(id)?.higherIsBetter === false) {
			lowerIsBetter.add(id);
		}
	}
	return lowerIsBetter;
}

interface EvalRunRequestBody {
	agent_id: string | null;
	dataset?: EvalDatasetCase[];
	evaluators?: string[];
	judge_model?: string;
	max_concurrency?: number;
	model?: string;
}

function writeEvalOutput(
	ctx: CliContext,
	flags: EvalFlags,
	result: EvalRunResult,
	report: EvalGateReport,
	gated: boolean
): void {
	if (flags.junit) {
		ctx.io.out(evalRunToJunit(result, report));
		return;
	}
	if (flags.json || ctx.flags.json) {
		const value = gated ? { ...result, gate: report } : result;
		ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}
	ctx.io.out(evalRunToText(result, report));
}

function emptyReport(): EvalGateReport {
	return { checks: [], failures: [], ok: true };
}

/** `ryu-cli eval` — replay a dataset through the Gateway and optionally gate on it. */
export const evalCommand: Command = {
	aliases: ["evaluate"],
	name: "eval",
	summary: "Run a Gateway eval dataset; fail below --threshold",
	usage: EVAL_USAGE,
	run: async (ctx) => {
		const flags = parseEvalFlags(ctx.rawArgs);
		let thresholds: EvalThresholds;
		try {
			thresholds = parseEvalThresholds(flags.thresholds);
		} catch (error) {
			throw new UsageError(errorText(error));
		}
		const scorers = parseScorerList(flags.scorers);
		const evaluatorIds = gatewayEvaluatorIds(scorers, thresholds);
		const lowerIsBetter = await resolveEvaluatorPolarity(ctx, evaluatorIds);

		const body: EvalRunRequestBody = {
			agent_id: flags.agent ?? flags.positional[0] ?? ctx.flags.agent ?? null,
		};
		const model = (flags.model ?? flags.positional[1])?.trim();
		if (model) {
			body.model = model;
		}
		const datasetPath = flags.dataset ?? ctx.flags.file;
		if (datasetPath) {
			body.dataset = await loadDataset(datasetPath);
		}
		if (evaluatorIds.length > 0) {
			body.evaluators = evaluatorIds;
		}
		if (flags.judgeModel) {
			body.judge_model = flags.judgeModel;
		}
		if (flags.concurrency !== null) {
			body.max_concurrency = flags.concurrency;
		}

		const raw = await coreJson(ctx, "/api/gateway/evals/run", { body });
		const parsed = gatewayEvalRunSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error("Gateway returned an unexpected eval result");
		}
		const result = parsed.data;
		const gated = gateTargets(scorers, thresholds).size > 0;
		const report = gated
			? evaluateEvalGate(result, { lowerIsBetter, scorers, thresholds })
			: emptyReport();
		writeEvalOutput(ctx, flags, result, report, gated);
		if (!report.ok) {
			ctx.io.err(
				`${tr("eval gate failed:")}\n  ${report.failures.join("\n  ")}\n`
			);
			return 1;
		}
		return 0;
	},
};

const redTeamResultSchema = z.looseObject({
	campaign_id: z.string().optional(),
	strategies: z
		.array(
			z.object({
				detail: z.string(),
				evaluator: z.string(),
				id: z.string(),
				name: z.string(),
				protected: z.boolean(),
			})
		)
		.optional(),
	summary: z
		.object({
			needs_attention: z.number(),
			protected: z.number(),
			total: z.number(),
		})
		.optional(),
});

/** `ryu-cli redteam` — run the bounded local probes; `--max-attention` gates CI. */
export const redteamCommand: Command = {
	aliases: ["red-team", "security-sweep"],
	name: "redteam",
	summary: "Run bounded local agent security probes",
	usage: REDTEAM_USAGE,
	run: async (ctx) => {
		const flags = parseEvalFlags(ctx.rawArgs);
		const agentId = flags.agent ?? flags.positional[0] ?? ctx.flags.agent;
		if (!agentId) {
			throw new UsageError(
				localize("Missing agent id. Usage: {usage}", { usage: REDTEAM_USAGE })
			);
		}
		const body: EvalRunRequestBody = { agent_id: agentId };
		const model = (flags.model ?? flags.positional[1])?.trim();
		if (model) {
			body.model = model;
		}
		const raw = await coreJson(ctx, "/api/gateway/redteam/run", { body });
		const parsed = redTeamResultSchema.safeParse(raw);
		const campaign: RedTeamGateInput = parsed.success ? parsed.data : {};
		const report =
			flags.maxAttention === null
				? emptyReport()
				: evaluateRedTeamGate(campaign, flags.maxAttention);
		if (flags.junit) {
			ctx.io.out(redTeamToJunit(campaign, report));
		} else {
			const value =
				flags.maxAttention === null || !parsed.success
					? raw
					: { ...parsed.data, gate: report };
			ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
		}
		if (!report.ok) {
			ctx.io.err(
				`${tr("redteam gate failed:")}\n  ${report.failures.join("\n  ")}\n`
			);
			return 1;
		}
		return 0;
	},
};
