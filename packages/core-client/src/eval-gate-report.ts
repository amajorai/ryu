// Report rendering for the shared eval CI gate (see `eval-gate.ts`): JUnit XML,
// a Markdown step summary, and a plain-text terminal summary.

import {
	type EvalGateCheck,
	type EvalGateReport,
	gateCheckFailure,
	type RedTeamGateInput,
	round,
} from "./eval-gate-check.ts";
import type { EvalCaseScore, EvalRunResult } from "./gateway.ts";

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
			: [`${check.metric} ${gateCheckFailure(check)}`];
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

/** A check's value for a summary row, noting cases left unscored. */
function checkValue(check: EvalGateCheck): string {
	if (check.value === null) {
		return "not measured";
	}
	const unscored = check.unscored ? ` (${check.unscored} unscored)` : "";
	return `${round(check.value)}${unscored}`;
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
				`| ${markdownCell(check.metric)} | ${markdownCell(check.model ?? "-")} | ${checkValue(check)} | ${check.threshold} | ${check.pass ? "pass" : "FAIL"} |`
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
			`${check.pass ? "PASS" : "FAIL"} gate ${check.metric}${scope}: ${checkValue(
				check
			)} >= ${check.threshold}`
		);
	}
	if (report.checks.length > 0) {
		lines.push(report.ok ? "eval gate passed" : "eval gate FAILED");
	}
	return `${lines.join("\n")}\n`;
}
