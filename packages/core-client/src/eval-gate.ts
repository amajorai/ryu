// Shared, network-free CI gate for Gateway eval and red-team results.
//
// `ryu eval` (apps/cli) and the GitHub Action (packages/github-action) both
// replay a dataset through Core's `/api/gateway/evals/run` proxy and then need
// the same three things: turn a JSON / JSONL / CSV dataset file into the
// Gateway's `EvalDatasetCase` wire shape, compare the run's aggregates against
// `--threshold <n|scorer=n>` bars, and render the outcome as JSON, JUnit XML, or
// a Markdown step summary. Keeping that here means a dataset or threshold that
// passes locally passes identically in CI.
//
// This file is the stable `@ryuhq/core-client/eval-gate` entry point; the code
// lives in `eval-gate-dataset.ts`, `eval-gate-check.ts` and
// `eval-gate-report.ts`.

export {
	BUILTIN_GATE_METRICS,
	type BuiltinGateMetric,
	type EvalGateCheck,
	type EvalGateOptions,
	type EvalGateReport,
	type EvalThresholds,
	evaluateEvalGate,
	evaluateRedTeamGate,
	gateTargets,
	gatewayEvaluatorIds,
	isBuiltinGateMetric,
	parseEvalThresholds,
	parseScorerList,
	type RedTeamGateInput,
} from "./eval-gate-check.ts";
export {
	detectEvalDatasetFormat,
	EvalDatasetError,
	type EvalDatasetFormat,
	parseCsv,
	parseEvalDataset,
} from "./eval-gate-dataset.ts";
export {
	caseFailures,
	escapeXml,
	evalRunToJunit,
	evalRunToMarkdown,
	evalRunToText,
	redTeamToJunit,
} from "./eval-gate-report.ts";
