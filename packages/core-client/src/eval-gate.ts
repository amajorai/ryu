// Shared, network-free CI gate for Gateway eval and red-team results.
//
// `ryu eval` (apps/cli) and the GitHub Action (packages/github-action) both
// replay a dataset through Core's `/api/gateway/evals/run` proxy and then need
// the same three things: turn a JSON / JSONL / CSV dataset file into the
// Gateway's `EvalDatasetCase` wire shape, compare the run's aggregates against
// `--threshold <n|scorer=n>` bars, and render the outcome as JSON, JUnit XML, or
// a Markdown step summary. Keeping that here means a dataset or threshold that
// passes locally passes identically in CI.

import { z } from "zod";
import {
	assertionSchema,
	type EvalCaseScore,
	type EvalDatasetCase,
	type EvalRunAggregate,
	type EvalRunResult,
} from "./gateway.ts";

// ── Datasets ─────────────────────────────────────────────────────────────────

/** File formats `parseEvalDataset` understands. */
export type EvalDatasetFormat = "csv" | "json" | "jsonl";

/** Thrown for a dataset file that cannot become Gateway eval cases. */
export class EvalDatasetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalDatasetError";
	}
}

/** A UTF-8 byte-order mark spreadsheet exports often prepend to CSV. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfe_ff);

/** Largest dataset a gate run accepts; Gateway caps a run well below this. */
const MAX_DATASET_CASES = 10_000;

const PROMPT_KEYS = ["prompt", "input", "question", "query"] as const;
const EXPECTED_KEYS = [
	"expected",
	"expected_output",
	"expectedOutput",
	"answer",
	"reference",
] as const;
/** Row keys copied onto the Gateway case unchanged (JSON forms only). */
const PASSTHROUGH_KEYS = [
	"assertions",
	"description",
	"evaluators",
	"messages",
	"metadata",
	"options",
	"provider",
	"providers",
	"threshold",
] as const;
const RESERVED_KEYS = new Set<string>([
	...PROMPT_KEYS,
	...EXPECTED_KEYS,
	...PASSTHROUGH_KEYS,
	"context",
	"id",
	"vars",
]);

const rowSchema = z.record(z.string(), z.json());
type DatasetRow = z.infer<typeof rowSchema>;
const datasetEnvelopeSchema = z.object({
	cases: z.array(z.json()).optional(),
	dataset: z.array(z.json()).optional(),
	// `@ryuhq/sdk/evals` writes `{ name, items }`; accept it so one file
	// serves both the SDK and the CLI/Action gate.
	items: z.array(z.json()).optional(),
	tests: z.array(z.json()).optional(),
});
const caseFieldsSchema = z.looseObject({
	assertions: z.array(assertionSchema).optional(),
	description: z.string().optional(),
	evaluators: z.array(z.string()).optional(),
	messages: z
		.array(
			z.object({
				content: z.string(),
				role: z.enum(["assistant", "system", "user"]),
			})
		)
		.optional(),
	metadata: z.record(z.string(), z.json()).optional(),
	options: z
		.object({
			cache: z.boolean().optional(),
			prefix: z.string().optional(),
			suffix: z.string().optional(),
			timeout_ms: z.number().int().positive().optional(),
			transform: z.string().optional(),
			transform_vars: z.string().optional(),
		})
		.optional(),
	provider: z.string().optional(),
	providers: z.array(z.string()).optional(),
	threshold: z.number().min(0).max(1).optional(),
	vars: z.record(z.string(), z.json()).optional(),
});

/** Pick the dataset format from a file name, falling back to the content. */
export function detectEvalDatasetFormat(
	text: string,
	fileName?: string
): EvalDatasetFormat {
	const lower = fileName?.toLowerCase() ?? "";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
		return "jsonl";
	}
	if (lower.endsWith(".json")) {
		return "json";
	}
	if (lower.endsWith(".csv")) {
		return "csv";
	}
	const trimmed = text.trimStart();
	if (trimmed.startsWith("[")) {
		return "json";
	}
	if (trimmed.startsWith("{")) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			return "jsonl";
		}
	}
	return "csv";
}

/**
 * Parse RFC 4180 CSV into rows of cells. Quoted fields may contain commas,
 * doubled quotes, and line breaks; CRLF and LF line endings are both accepted.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let index = 0;
	const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
	while (index < source.length) {
		const char = source[index];
		if (quoted) {
			if (char === '"' && source[index + 1] === '"') {
				cell += '"';
				index += 2;
				continue;
			}
			if (char === '"') {
				quoted = false;
			} else {
				cell += char;
			}
			index += 1;
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
		} else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (char === "\r" && source[index + 1] === "\n") {
				index += 1;
			}
		} else {
			cell += char;
		}
		index += 1;
	}
	if (quoted) {
		throw new EvalDatasetError("CSV ends inside a quoted field");
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

function csvRows(text: string): DatasetRow[] {
	const [header, ...body] = parseCsv(text);
	if (!header) {
		return [];
	}
	const columns = header.map((name) => name.trim());
	return body.map((cells, rowIndex) => {
		if (cells.length > columns.length) {
			throw new EvalDatasetError(
				`CSV row ${rowIndex + 2} has ${cells.length} cells but the header has ${columns.length}`
			);
		}
		const row: DatasetRow = {};
		for (const [column, name] of columns.entries()) {
			if (name !== "") {
				row[name] = cells[column] ?? "";
			}
		}
		return row;
	});
}

function jsonRows(text: string): DatasetRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new EvalDatasetError(
			`dataset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const list = Array.isArray(parsed)
		? parsed
		: (() => {
				const envelope = datasetEnvelopeSchema.safeParse(parsed);
				const rows = envelope.success
					? (envelope.data.cases ??
						envelope.data.items ??
						envelope.data.dataset ??
						envelope.data.tests)
					: undefined;
				if (!rows) {
					throw new EvalDatasetError(
						"a JSON dataset must be an array of cases or an object with a `cases` (or `items`) array"
					);
				}
				return rows;
			})();
	return list.map((value, index) => objectRow(value, `case ${index + 1}`));
}

function jsonlRows(text: string): DatasetRow[] {
	const rows: DatasetRow[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line.trim() === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new EvalDatasetError(
				`JSONL line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		rows.push(objectRow(parsed, `JSONL line ${index + 1}`));
	}
	return rows;
}

function objectRow(value: unknown, label: string): DatasetRow {
	const parsed = rowSchema.safeParse(value);
	if (!parsed.success) {
		throw new EvalDatasetError(`${label} must be a JSON object`);
	}
	return parsed.data;
}

function firstText(
	row: DatasetRow,
	keys: readonly string[]
): string | undefined {
	for (const key of keys) {
		const value = row[key];
		if (value === undefined || value === null) {
			continue;
		}
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text.trim() !== "") {
			return text;
		}
	}
	return;
}

function parseContext(value: DatasetRow[string] | undefined): unknown {
	if (typeof value !== "string") {
		return value ?? undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return;
	}
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return value;
}

function rowToCase(row: DatasetRow, index: number): EvalDatasetCase {
	const fields = caseFieldsSchema.safeParse(row);
	if (!fields.success) {
		const issue = fields.error.issues[0];
		throw new EvalDatasetError(
			`case ${index + 1} field \`${issue?.path.join(".") ?? "?"}\` is invalid: ${issue?.message ?? "unknown"}`
		);
	}
	const prompt = firstText(row, PROMPT_KEYS) ?? "";
	const messages = fields.data.messages;
	if (prompt.trim() === "" && !(messages && messages.length > 0)) {
		throw new EvalDatasetError(
			`case ${index + 1} needs a prompt (one of: ${PROMPT_KEYS.join(", ")}) or messages`
		);
	}
	const testCase: EvalDatasetCase = { prompt };
	const id = firstText(row, ["id"]);
	if (id) {
		testCase.id = id;
	}
	const expected = firstText(row, EXPECTED_KEYS);
	if (expected !== undefined) {
		testCase.expected = expected;
	}
	const context = parseContext(row.context);
	if (context !== undefined) {
		testCase.context = context;
	}
	const vars: Record<string, z.infer<typeof rowSchema>[string]> = {
		...(fields.data.vars ?? {}),
	};
	for (const [key, value] of Object.entries(row)) {
		if (!RESERVED_KEYS.has(key)) {
			vars[key] = value;
		}
	}
	if (Object.keys(vars).length > 0) {
		testCase.vars = vars;
	}
	const { data } = fields;
	if (data.assertions) {
		testCase.assertions = data.assertions;
	}
	if (data.description) {
		testCase.description = data.description;
	}
	if (data.evaluators) {
		testCase.evaluators = data.evaluators;
	}
	if (messages) {
		testCase.messages = messages;
	}
	if (data.metadata) {
		testCase.metadata = data.metadata;
	}
	if (data.options) {
		testCase.options = data.options;
	}
	if (data.provider) {
		testCase.provider = data.provider;
	}
	if (data.providers) {
		testCase.providers = data.providers;
	}
	if (data.threshold !== undefined) {
		testCase.threshold = data.threshold;
	}
	return testCase;
}

/**
 * Turn dataset file text into Gateway eval cases. Each row needs a prompt
 * (`prompt`, `input`, `question`, or `query`) and may carry an `expected`
 * answer (`expected`, `expected_output`, `answer`, or `reference`), a
 * `context`, an `id`, and any Gateway case field (`assertions`, `evaluators`,
 * `messages`, …). Unrecognized columns become `{{vars}}`.
 */
export function parseEvalDataset(
	text: string,
	options: { fileName?: string; format?: EvalDatasetFormat } = {}
): EvalDatasetCase[] {
	const format =
		options.format ?? detectEvalDatasetFormat(text, options.fileName);
	let rows: DatasetRow[];
	if (format === "csv") {
		rows = csvRows(text);
	} else if (format === "jsonl") {
		rows = jsonlRows(text);
	} else {
		rows = jsonRows(text);
	}
	if (rows.length === 0) {
		throw new EvalDatasetError("dataset has no cases");
	}
	if (rows.length > MAX_DATASET_CASES) {
		throw new EvalDatasetError(
			`dataset has ${rows.length} cases; the limit is ${MAX_DATASET_CASES}`
		);
	}
	return rows.map(rowToCase);
}

// ── Thresholds ───────────────────────────────────────────────────────────────

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

function aggregatesOf(
	result: EvalRunResult
): { aggregate: EvalRunAggregate; model: string | null }[] {
	if (result.models && result.models.length > 0) {
		return result.models.map((entry) => ({
			aggregate: entry.aggregate,
			model: entry.model,
		}));
	}
	return [{ aggregate: result.aggregate, model: null }];
}

function round(value: number): string {
	return Number(value.toFixed(4)).toString();
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
	for (const { aggregate, model } of aggregatesOf(result)) {
		for (const [metric, threshold] of targets) {
			const value = metricValue(aggregate, metric, lowerIsBetter);
			const pass = value !== null && value >= threshold;
			checks.push({ metric, model, pass, threshold, value });
			if (pass) {
				continue;
			}
			const scope = model ? ` (${model})` : "";
			failures.push(
				value === null
					? `${metric}${scope} was not measured; it cannot meet ${threshold}`
					: `${metric}${scope} ${round(value)} is below ${threshold}`
			);
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

// ── Reports ──────────────────────────────────────────────────────────────────

const XML_ESCAPES: Record<string, string> = {
	'"': "&quot;",
	"&": "&amp;",
	"'": "&apos;",
	"<": "&lt;",
	">": "&gt;",
};
// XML 1.0 forbids most C0 control characters even when escaped.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Escape text for an XML attribute or text node. */
export function escapeXml(value: string): string {
	return value
		.replace(XML_INVALID, "")
		.replace(/["&'<>]/g, (char) => XML_ESCAPES[char] ?? char);
}

const CASE_NAME_CHARS = 80;

function caseName(score: EvalCaseScore, index: number): string {
	if (score.id) {
		return score.id;
	}
	const prompt = score.prompt.replace(/\s+/g, " ").trim();
	const short =
		prompt.length > CASE_NAME_CHARS
			? `${prompt.slice(0, CASE_NAME_CHARS - 1)}…`
			: prompt;
	return `case ${index + 1}: ${short}`;
}

/** Why one case failed, or an empty list when it passed. */
export function caseFailures(score: EvalCaseScore): string[] {
	const reasons: string[] = [];
	if (score.error) {
		reasons.push(`error: ${score.error}`);
	}
	for (const assertion of score.assertions) {
		if (!assertion.pass) {
			reasons.push(`${assertion.kind}: ${assertion.detail}`);
		}
	}
	if (!score.assertions_pass && reasons.length === 0) {
		reasons.push(
			`assertion score ${round(score.assertion_score ?? 0)} is below the case threshold`
		);
	}
	for (const evaluator of score.evaluators ?? []) {
		if (evaluator.executed && !evaluator.pass) {
			reasons.push(`${evaluator.id}: ${evaluator.detail}`);
		}
	}
	return reasons;
}

function junitCase(
	suite: string,
	name: string,
	failures: string[],
	extra = ""
): string {
	const open = `    <testcase classname="${escapeXml(suite)}" name="${escapeXml(name)}"${extra}`;
	if (failures.length === 0) {
		return `${open}/>`;
	}
	const message = escapeXml(failures[0] ?? "failed");
	return `${open}>\n      <failure message="${message}">${escapeXml(failures.join("\n"))}</failure>\n    </testcase>`;
}

function junitSuite(name: string, cases: string[], failed: number): string {
	return `  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${failed}">\n${cases.join("\n")}\n  </testsuite>`;
}

function gateSuite(report: EvalGateReport): string | null {
	if (report.checks.length === 0) {
		return null;
	}
	const cases = report.checks.map((check) => {
		const scope = check.model ? ` (${check.model})` : "";
		const failure = check.pass
			? []
			: [
					check.value === null
						? `${check.metric} was not measured`
						: `${check.metric} ${round(check.value)} is below ${check.threshold}`,
				];
		return junitCase(
			"ryu.eval.gate",
			`${check.metric}${scope} >= ${check.threshold}`,
			failure
		);
	});
	return junitSuite(
		"ryu.eval.gate",
		cases,
		report.checks.filter((check) => !check.pass).length
	);
}

/** Render an eval run (and its gate) as JUnit XML for CI test reporters. */
export function evalRunToJunit(
	result: EvalRunResult,
	report: EvalGateReport
): string {
	const suites: string[] = [];
	const blocks =
		result.models && result.models.length > 0
			? result.models.map((entry) => ({
					cases: entry.cases,
					name: `ryu.eval.${entry.model}`,
				}))
			: [{ cases: result.cases, name: "ryu.eval" }];
	for (const block of blocks) {
		let failed = 0;
		const cases = block.cases.map((score, index) => {
			const failures = caseFailures(score);
			if (failures.length > 0) {
				failed += 1;
			}
			const seconds =
				score.latency_available === false || score.latency_ms === undefined
					? ""
					: ` time="${(score.latency_ms / 1000).toFixed(3)}"`;
			return junitCase(block.name, caseName(score, index), failures, seconds);
		});
		suites.push(junitSuite(block.name, cases, failed));
	}
	const gate = gateSuite(report);
	if (gate) {
		suites.push(gate);
	}
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ryu eval">\n${suites.join("\n")}\n</testsuites>\n`;
}

/** Render a red-team campaign (and its gate) as JUnit XML. */
export function redTeamToJunit(
	result: RedTeamGateInput,
	report: EvalGateReport
): string {
	const name = "ryu.redteam";
	const strategies = result.strategies ?? [];
	const cases = strategies.map((strategy) =>
		junitCase(
			name,
			`${strategy.id}: ${strategy.name}`,
			strategy.protected
				? []
				: [`${strategy.evaluator} needs attention: ${strategy.detail}`]
		)
	);
	const suites = [
		junitSuite(
			name,
			cases,
			strategies.filter((strategy) => !strategy.protected).length
		),
	];
	const gate = gateSuite(report);
	if (gate) {
		suites.push(gate);
	}
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ryu redteam">\n${suites.join("\n")}\n</testsuites>\n`;
}

const MARKDOWN_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"*": "\\*",
	"[": "\\[",
	_: "\\_",
	"`": "'",
	"|": "\\|",
};

/**
 * One line of untrusted text (case names, judge details) made safe for a
 * Markdown table cell or list item: no HTML, links, emphasis,
 * code spans, or table pipes.
 */
function markdownCell(value: string): string {
	return value
		.replace(/[&*<>[_`|]/g, (char) => MARKDOWN_ESCAPES[char] ?? char)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A compact Markdown summary (GitHub step summary / PR comment): one row per
 * threshold check plus the failing cases. Response text is never included.
 */
export function evalRunToMarkdown(
	result: EvalRunResult,
	report: EvalGateReport
): string {
	const lines = [
		`## Ryu eval ${report.ok ? "passed" : "failed"}`,
		"",
		`- Cases: ${result.aggregate.total_cases}`,
		`- Mean overall: ${round(result.aggregate.mean_overall)}`,
	];
	if (result.aggregate.assertion_pass_rate !== undefined) {
		lines.push(
			`- Assertion pass rate: ${round(result.aggregate.assertion_pass_rate)}`
		);
	}
	if (report.checks.length > 0) {
		lines.push("", "| Scorer | Model | Value | Threshold | Result |");
		lines.push("|---|---|---|---|---|");
		for (const check of report.checks) {
			lines.push(
				`| ${markdownCell(check.metric)} | ${markdownCell(check.model ?? "-")} | ${check.value === null ? "not measured" : round(check.value)} | ${check.threshold} | ${check.pass ? "pass" : "FAIL"} |`
			);
		}
	}
	const failing = result.cases
		.map((score, index) => ({
			name: caseName(score, index),
			reasons: caseFailures(score),
		}))
		.filter((entry) => entry.reasons.length > 0);
	if (failing.length > 0) {
		lines.push("", `### Failing cases (${failing.length})`, "");
		for (const entry of failing.slice(0, 50)) {
			lines.push(
				`- **${markdownCell(entry.name)}**: ${markdownCell(entry.reasons[0] ?? "")}`
			);
		}
		if (failing.length > 50) {
			lines.push(`- …and ${failing.length - 50} more`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** A plain-text terminal summary of an eval run and its gate. */
export function evalRunToText(
	result: EvalRunResult,
	report: EvalGateReport
): string {
	const lines = [
		`cases ${result.aggregate.total_cases} · mean overall ${round(result.aggregate.mean_overall)}${
			result.aggregate.assertion_pass_rate === undefined
				? ""
				: ` · assertions ${round(result.aggregate.assertion_pass_rate)}`
		}`,
	];
	for (const [id, row] of Object.entries(result.aggregate.evaluators ?? {})) {
		lines.push(
			`  ${id}: mean ${round(row.meanScore)} · pass rate ${round(row.passRate)} · executed ${row.executedCount}`
		);
	}
	for (const [index, score] of result.cases.entries()) {
		const reasons = caseFailures(score);
		if (reasons.length > 0) {
			lines.push(`FAIL ${caseName(score, index)} — ${reasons[0]}`);
		}
	}
	for (const check of report.checks) {
		const scope = check.model ? ` (${check.model})` : "";
		lines.push(
			`${check.pass ? "PASS" : "FAIL"} gate ${check.metric}${scope}: ${
				check.value === null ? "not measured" : round(check.value)
			} >= ${check.threshold}`
		);
	}
	if (report.checks.length > 0) {
		lines.push(report.ok ? "eval gate passed" : "eval gate FAILED");
	}
	return `${lines.join("\n")}\n`;
}
