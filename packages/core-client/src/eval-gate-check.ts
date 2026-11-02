// Threshold parsing and gate evaluation for the shared eval CI gate (see
// `eval-gate.ts`): compares a Gateway eval run, or a red-team campaign, with
// its `--threshold` bars.

import { EvalDatasetError } from "./eval-gate-dataset.ts";
import type {
	EvalCaseScore,
	EvalRunAggregate,
	EvalRunResult,
} from "./gateway.ts";

/**
 * Aggregate metrics a threshold can name besides a catalog evaluator id.
 * Every metric is "higher is better" in [0, 1].
 */
export const BUILTIN_GATE_METRICS = {
	assertions: "assertion pass rate",
	latency: "mean latency score",
	overall: "mean overall score",
	policy: "policy pass rate",
	substring: "mean expected-substring match",
} as const;
export type BuiltinGateMetric = keyof typeof BUILTIN_GATE_METRICS;

/** Parsed `--threshold` values. */
export interface EvalThresholds {
	/** A bare `--threshold <n>`: applies to every requested scorer. */
	defaultMin: number | null;
	/** `--threshold <scorer>=<n>` entries, keyed by metric or evaluator id. */
	perMetric: Record<string, number>;
}

function parseUnitInterval(raw: string, label: string): number {
	const trimmed = raw.trim();
	const value = Number(trimmed);
	if (trimmed === "" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new EvalDatasetError(
			`${label} must be a number between 0 and 1 (got '${raw}')`
		);
	}
	return value;
}

/**
 * Parse threshold specs (`0.8`, `overall=0.7`, `toxicity=0.95`). Each spec may
 * itself be a comma-separated list, so one CI input can carry several.
 */
export function parseEvalThresholds(specs: readonly string[]): EvalThresholds {
	const thresholds: EvalThresholds = { defaultMin: null, perMetric: {} };
	for (const spec of specs.flatMap((value) => value.split(/[,\n]/))) {
		const trimmed = spec.trim();
		if (trimmed === "") {
			continue;
		}
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			thresholds.defaultMin = parseUnitInterval(trimmed, "threshold");
			continue;
		}
		const metric = trimmed.slice(0, eq).trim();
		if (metric === "") {
			throw new EvalDatasetError(`threshold '${trimmed}' names no scorer`);
		}
		thresholds.perMetric[metric] = parseUnitInterval(
			trimmed.slice(eq + 1),
			`threshold for '${metric}'`
		);
	}
	return thresholds;
}

/** Split repeatable / comma-separated scorer ids into a de-duplicated list. */
export function parseScorerList(values: readonly string[]): string[] {
	const ids: string[] = [];
	for (const id of values.flatMap((value) => value.split(/[,\n]/))) {
		const trimmed = id.trim();
		if (trimmed !== "" && !ids.includes(trimmed)) {
			ids.push(trimmed);
		}
	}
	return ids;
}

/** Whether `id` names a built-in aggregate metric rather than an evaluator. */
export function isBuiltinGateMetric(id: string): id is BuiltinGateMetric {
	return Object.hasOwn(BUILTIN_GATE_METRICS, id);
}

/**
 * Scorer ids that must be sent to Gateway as registry evaluators: requested
 * scorers and threshold keys that are not built-in aggregate metrics.
 */
export function gatewayEvaluatorIds(
	scorers: readonly string[],
	thresholds: EvalThresholds
): string[] {
	return parseScorerList([
		...scorers,
		...Object.keys(thresholds.perMetric),
	]).filter((id) => !isBuiltinGateMetric(id));
}

// ── Gate evaluation ──────────────────────────────────────────────────────────

/** One threshold comparison. */
export interface EvalGateCheck {
	/** Metric or evaluator id. */
	metric: string;
	/** Model the aggregate belongs to (multi-model runs), when known. */
	model: string | null;
	pass: boolean;
	threshold: number;
	/**
	 * Cases that requested this evaluator but were left unscored (the judge
	 * refused, was filtered or cut off, or gave no verdict). Any unscored case
	 * fails the check, because the mean covers only the scored cases.
	 */
	unscored?: number;
	/** Normalized higher-is-better value, or null when it was never measured. */
	value: number | null;
}

/** Outcome of comparing one eval run against its thresholds. */
export interface EvalGateReport {
	checks: EvalGateCheck[];
	failures: string[];
	ok: boolean;
}

/** Inputs for {@link evaluateEvalGate}. */
export interface EvalGateOptions {
	/**
	 * Evaluator ids whose raw judge score measures a BAD signal (Gateway's
	 * `higherIsBetter: false`, e.g. toxicity). Their mean is inverted so every
	 * threshold reads "at least this good".
	 */
	lowerIsBetter?: ReadonlySet<string>;
	/** Scorers the run requested; a bare threshold applies to each of them. */
	scorers: readonly string[];
	thresholds: EvalThresholds;
}

function builtinValue(
	aggregate: EvalRunAggregate,
	metric: BuiltinGateMetric
): number | null {
	switch (metric) {
		case "assertions":
			return aggregate.assertion_pass_rate ?? null;
		case "latency":
			return aggregate.latency_available_cases === 0
				? null
				: aggregate.mean_latency;
		case "overall":
			return aggregate.mean_overall;
		case "policy":
			return aggregate.policy_available_cases === 0
				? null
				: aggregate.policy_pass_rate;
		case "substring":
			return aggregate.mean_substring_match;
		default:
			return null;
	}
}

function metricValue(
	aggregate: EvalRunAggregate,
	metric: string,
	lowerIsBetter: ReadonlySet<string>
): number | null {
	if (isBuiltinGateMetric(metric)) {
		return builtinValue(aggregate, metric);
	}
	const row = aggregate.evaluators?.[metric];
	if (!row || row.executedCount === 0) {
		return null;
	}
	return lowerIsBetter.has(metric) ? 1 - row.meanScore : row.meanScore;
}

/** The metric → minimum map a gate run enforces. Empty = nothing gated. */
export function gateTargets(
	scorers: readonly string[],
	thresholds: EvalThresholds
): Map<string, number> {
	const targets = new Map<string, number>();
	if (thresholds.defaultMin !== null) {
		const defaults = scorers.length > 0 ? scorers : ["overall"];
		for (const scorer of defaults) {
			targets.set(scorer, thresholds.defaultMin);
		}
	}
	for (const [metric, min] of Object.entries(thresholds.perMetric)) {
		targets.set(metric, min);
	}
	return targets;
}

function aggregatesOf(result: EvalRunResult): {
	aggregate: EvalRunAggregate;
	cases: EvalCaseScore[];
	model: string | null;
}[] {
	if (result.models && result.models.length > 0) {
		return result.models.map((entry) => ({
			aggregate: entry.aggregate,
			cases: entry.cases,
			model: entry.model,
		}));
	}
	return [{ aggregate: result.aggregate, cases: result.cases, model: null }];
}

/**
 * How many cases requested evaluator `metric` without it producing a score.
 * Gateway's aggregate averages only executed results, so without this a judge
 * that refuses the hard cases (the toxic ones, say) would let the gate pass on
 * the easy remainder.
 */
function unscoredCases(
	cases: readonly EvalCaseScore[],
	metric: string
): number {
	let unscored = 0;
	for (const score of cases) {
		const results = (score.evaluators ?? []).filter(
			(evaluator) => evaluator.id === metric
		);
		if (results.some((evaluator) => !evaluator.executed)) {
			unscored += 1;
		}
	}
	return unscored;
}

/** Format a gate value for messages: at most four decimals, no trailing zeros. */
export function round(value: number): string {
	return Number(value.toFixed(4)).toString();
}

/** Why a failed check failed, without its metric name. */
export function gateCheckFailure(check: EvalGateCheck): string {
	if (check.value === null) {
		return `was not measured; it cannot meet ${check.threshold}`;
	}
	if (check.unscored) {
		return `left ${check.unscored} case(s) unscored; a partly measured scorer cannot meet ${check.threshold}`;
	}
	return `${round(check.value)} is below ${check.threshold}`;
}

/** Compare a Gateway eval run against its thresholds. */
export function evaluateEvalGate(
	result: EvalRunResult,
	options: EvalGateOptions
): EvalGateReport {
	const lowerIsBetter = options.lowerIsBetter ?? new Set<string>();
	const targets = gateTargets(options.scorers, options.thresholds);
	const checks: EvalGateCheck[] = [];
	const failures: string[] = [];
	for (const { aggregate, cases, model } of aggregatesOf(result)) {
		for (const [metric, threshold] of targets) {
			const value = metricValue(aggregate, metric, lowerIsBetter);
			const unscored = isBuiltinGateMetric(metric)
				? 0
				: unscoredCases(cases, metric);
			const pass = value !== null && value >= threshold && unscored === 0;
			const check: EvalGateCheck = { metric, model, pass, threshold, value };
			if (unscored > 0) {
				check.unscored = unscored;
			}
			checks.push(check);
			if (!pass) {
				const scope = model ? ` (${model})` : "";
				failures.push(`${metric}${scope} ${gateCheckFailure(check)}`);
			}
		}
	}
	if (targets.size > 0) {
		failures.push(...erroredCaseFailures(result));
	}
	return { checks, failures, ok: failures.length === 0 };
}

/**
 * A case that errored (provider failure, timeout) has no real output, so a
 * gate must not pass on it even when its placeholder scores look clean.
 */
function erroredCaseFailures(result: EvalRunResult): string[] {
	const failures: string[] = [];
	const groups: { cases: EvalCaseScore[]; model: string | null }[] =
		result.models && result.models.length > 0
			? result.models.map((entry) => ({
					cases: entry.cases,
					model: entry.model,
				}))
			: [{ cases: result.cases, model: null }];
	for (const { cases, model } of groups) {
		const errored = cases.filter((score) => Boolean(score.error)).length;
		if (errored > 0) {
			const scope = model ? ` (${model})` : "";
			failures.push(
				`${errored} of ${cases.length} case(s)${scope} errored; a run with errored cases cannot pass`
			);
		}
	}
	return failures;
}

// ── Red-team gate ────────────────────────────────────────────────────────────

/** The subset of a red-team campaign result the gate reads. */
export interface RedTeamGateInput {
	campaign_id?: string;
	strategies?: {
		detail: string;
		evaluator: string;
		id: string;
		name: string;
		protected: boolean;
	}[];
	summary?: { needs_attention: number; protected: number; total: number };
}

/** Fail when more probes need attention than `maxAttention` allows. */
export function evaluateRedTeamGate(
	result: RedTeamGateInput,
	maxAttention: number
): EvalGateReport {
	const attention = result.summary?.needs_attention ?? null;
	const pass = attention !== null && attention <= maxAttention;
	return {
		checks: [
			{
				metric: "needs_attention",
				model: null,
				pass,
				threshold: maxAttention,
				value: attention,
			},
		],
		failures: pass
			? []
			: [
					attention === null
						? "red-team result has no summary"
						: `${attention} probe(s) need attention (maximum ${maxAttention})`,
				],
		ok: pass,
	};
}
