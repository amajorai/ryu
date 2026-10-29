// `ryu-cli plugin doctor|eval`: per-plugin doctor findings and eval results.

import { tf, tr } from "../../i18n/translate.ts";
import { type Command, UsageError } from "../types.ts";
import { doctorCount, doctorRecord, doctorString } from "./doctor.ts";
import {
	type CommandJsonValue,
	callCore,
	isCommandNumber,
	isCommandString,
} from "./shared.ts";

interface PluginDoctorFindingView {
	category: string;
	checkId: string;
	detail: string;
	pluginId: string;
	recommendedAction: string;
	severity: string;
	summary: string;
}

interface PluginDoctorResponseView {
	counts: { errors: number; info: number; plugins: number; warnings: number };
	findings: PluginDoctorFindingView[];
	plugins: {
		findingCount: number;
		id: string;
		name: string;
		status: string;
	}[];
	score: number;
}

function parsePluginDoctorFinding(
	value: CommandJsonValue
): PluginDoctorFindingView {
	const record = doctorRecord(value, "plugin doctor finding");
	return {
		category: doctorString(record, "category", "unknown"),
		checkId: doctorString(record, "checkId", "unknown"),
		detail: doctorString(record, "detail"),
		pluginId: doctorString(record, "pluginId", "unknown"),
		recommendedAction: doctorString(record, "recommendedAction"),
		severity: doctorString(record, "severity", "info"),
		summary: doctorString(record, "summary", "Unknown finding"),
	};
}

function parsePluginDoctorResponse(
	value: CommandJsonValue
): PluginDoctorResponseView {
	const record = doctorRecord(value, "plugin doctor response");
	const counts = doctorRecord(record.counts, "plugin doctor counts");
	const plugins = Array.isArray(record.plugins) ? record.plugins : [];
	const findings = Array.isArray(record.findings)
		? record.findings.map(parsePluginDoctorFinding)
		: [];
	return {
		counts: {
			errors: doctorCount(counts, "errors"),
			info: doctorCount(counts, "info"),
			plugins: doctorCount(counts, "plugins"),
			warnings: doctorCount(counts, "warnings"),
		},
		findings,
		plugins: plugins.map((value) => {
			const plugin = doctorRecord(value, "plugin doctor inventory");
			return {
				findingCount: doctorCount(plugin, "findingCount"),
				id: doctorString(plugin, "id", "unknown"),
				name: doctorString(plugin, "name", "Unknown plugin"),
				status: doctorString(plugin, "status", "unknown"),
			};
		}),
		score: isCommandNumber(record.score) ? record.score : 0,
	};
}

function renderPluginDoctorResponse(result: PluginDoctorResponseView): string {
	const lines = [
		tf(
			"Plugin Doctor · {score}/100 · {count, plural, one {# artifact} other {# artifacts}}",
			{ count: result.counts.plugins, score: result.score }
		),
		tf(
			"{errors, plural, one {# error} other {# errors}} · {warnings, plural, one {# warning} other {# warnings}}",
			{ errors: result.counts.errors, warnings: result.counts.warnings }
		),
		tr(
			"Read-only lint: Core validated the loaded manifest and lifecycle state; it did not execute plugin code or start sidecars."
		),
		"",
	];
	if (result.plugins.length > 0) {
		for (const plugin of result.plugins) {
			lines.push(
				`${plugin.status.padEnd(7)} ${plugin.id} · ${plugin.name}`,
				plugin.findingCount > 0
					? `  ${tf("{count, plural, one {# finding} other {# findings}}", { count: plugin.findingCount })}`
					: `  ${tr("no findings")}`
			);
		}
		lines.push("");
	}
	if (result.findings.length === 0) {
		lines.push(
			tr(
				"Healthy — no manifest, lifecycle, dependency, or permission drift found."
			)
		);
	} else {
		for (const finding of result.findings) {
			lines.push(
				`[${finding.severity}] ${finding.pluginId} · ${finding.summary}`,
				`  ${finding.detail}`,
				`  ${tf("action: {action}", { action: finding.recommendedAction })}`,
				`  ${tf("check: {id}", { id: finding.checkId })}`,
				""
			);
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

interface PluginEvalResponseView {
	artifactKind: string;
	cases: {
		failed: number;
		name: string;
		passed: number;
		score: number | null;
		status: string;
	}[];
	evidenceLevel: string;
	pluginId: string;
	score: number | null;
	status: string;
	suite: {
		caseCount: number;
		graderCount: number;
		status: string;
		unsupportedGraders: string[];
	};
}

function parsePluginEvalResponse(
	value: CommandJsonValue
): PluginEvalResponseView {
	const record = doctorRecord(value, "plugin eval response");
	const suite = doctorRecord(record.suite, "plugin eval suite");
	const cases = Array.isArray(record.cases) ? record.cases : [];
	return {
		artifactKind: doctorString(record, "artifactKind", "plugin"),
		cases: cases.map((value) => {
			const item = doctorRecord(value, "plugin eval case");
			return {
				failed: doctorCount(item, "failed"),
				name: doctorString(item, "name", "Unknown case"),
				passed: doctorCount(item, "passed"),
				score: isCommandNumber(item.score) ? item.score : null,
				status: doctorString(item, "status", "unknown"),
			};
		}),
		evidenceLevel: doctorString(record, "evidenceLevel", "unknown"),
		pluginId: doctorString(record, "pluginId", "unknown"),
		score: isCommandNumber(record.score) ? record.score : null,
		status: doctorString(record, "status", "unknown"),
		suite: {
			caseCount: doctorCount(suite, "caseCount"),
			graderCount: doctorCount(suite, "graderCount"),
			status: doctorString(suite, "status", "unknown"),
			unsupportedGraders: Array.isArray(suite.unsupportedGraders)
				? suite.unsupportedGraders.filter((value): value is string =>
						isCommandString(value)
					)
				: [],
		},
	};
}

function renderPluginEvalResponse(result: PluginEvalResponseView): string {
	const score =
		result.score === null ? "—" : `${Math.round(result.score * 100)}/100`;
	const lines = [
		tf("Plugin Evals · {id} · {score} · {status}", {
			id: result.pluginId,
			score,
			status: result.status,
		}),
		tf(
			"{cases, plural, one {# case} other {# cases}} · {graders, plural, one {# grader} other {# graders}} · evidence {evidence}",
			{
				cases: result.suite.caseCount,
				evidence: result.evidenceLevel,
				graders: result.suite.graderCount,
			}
		),
		"",
	];
	for (const item of result.cases) {
		const caseScore =
			item.score === null ? "—" : `${Math.round(item.score * 100)}/100`;
		lines.push(`  ${item.status.padEnd(11)} ${caseScore}  ${item.name}`);
	}
	if (result.suite.unsupportedGraders.length > 0) {
		lines.push(
			"",
			tf("Skipped grader types: {types}", {
				types: result.suite.unsupportedGraders.join(", "),
			})
		);
	}
	lines.push(
		"",
		tr(
			"Ryu runs the enabled artifact through Core's normal agent path. The no-plugin baseline is not run because Ryu never disables a live installation."
		)
	);
	return `${lines.join("\n").trimEnd()}\n`;
}

export const pluginDoctorCommand: Command = {
	aliases: ["app"],
	name: "plugin",
	summary: "Validate or evaluate an installed plugin or app",
	usage: "ryu-cli plugin <doctor|eval> [id] [--json]",
	run: async (ctx) => {
		const action = ctx.args[0];
		if (action !== "doctor" && action !== "eval") {
			throw new UsageError("Usage: ryu-cli plugin <doctor|eval> [id] [--json]");
		}
		if (ctx.args.length > 2) {
			throw new UsageError("Usage: ryu-cli plugin <doctor|eval> [id] [--json]");
		}
		const id = ctx.args[1];
		if (action === "eval") {
			if (!id) {
				throw new UsageError("Usage: ryu-cli plugin eval <id> [--json]");
			}
			const raw = await callCore(ctx, "/api/plugins/evals/run", {
				method: "POST",
				body: { id },
			});
			const result = parsePluginEvalResponse(raw);
			ctx.io.out(
				ctx.flags.json
					? `${JSON.stringify(raw, null, 2)}\n`
					: renderPluginEvalResponse(result)
			);
			return result.status === "passed" ? 0 : 1;
		}
		const path = id
			? `/api/plugins/doctor?id=${encodeURIComponent(id)}`
			: "/api/plugins/doctor";
		const raw = await callCore(ctx, path, { method: "GET" });
		const result = parsePluginDoctorResponse(raw);
		ctx.io.out(
			ctx.flags.json
				? `${JSON.stringify(raw, null, 2)}\n`
				: renderPluginDoctorResponse(result)
		);
		return result.counts.errors > 0 ? 1 : 0;
	},
};
