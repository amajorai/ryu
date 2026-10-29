// `ryu-cli doctor`: Core's node doctor report, its fixes and dry runs.

import { tf, tr } from "../../i18n/translate.ts";
import { runAgentsDoctor } from "../agentCommands.ts";
import { type Command, UsageError } from "../types.ts";
import {
	asRecord,
	type CommandJsonRecord,
	type CommandJsonValue,
	callCore,
	isCommandNumber,
	isCommandString,
} from "./shared.ts";

interface DoctorFindingView {
	canAutoFix: boolean;
	category: string;
	checkId: string;
	detail: string;
	recommendedAction: string | null;
	settingPath: string | null;
	severity: string;
	summary: string;
}

interface DoctorReportView {
	counts: { errors: number; info: number; warnings: number };
	findings: DoctorFindingView[];
	posture: string;
}

interface DoctorFixView {
	action: string;
	checkId: string;
	settingPath: string;
	summary: string;
}

interface DoctorResponseView {
	appliedFixes: DoctorFixView[];
	dryRun: boolean;
	plannedFixes: DoctorFixView[];
	report: DoctorReportView;
}

export function doctorRecord(
	value: CommandJsonValue,
	label: string
): CommandJsonRecord {
	const record = asRecord(value);
	if (!record) {
		throw new Error(`Gateway Doctor returned an invalid ${label}.`);
	}
	return record;
}

export function doctorString(
	record: CommandJsonRecord,
	key: string,
	defaultValue = ""
): string {
	return isCommandString(record[key]) ? record[key] : defaultValue;
}

export function doctorCount(record: CommandJsonRecord, key: string): number {
	const value = record[key];
	return isCommandNumber(value) ? value : 0;
}

function parseDoctorFinding(value: CommandJsonValue): DoctorFindingView {
	const record = doctorRecord(value, "finding");
	return {
		canAutoFix: record.canAutoFix === true,
		category: doctorString(record, "category", "unknown"),
		checkId: doctorString(record, "checkId", "unknown"),
		detail: doctorString(record, "detail"),
		recommendedAction: isCommandString(record.recommendedAction)
			? record.recommendedAction
			: null,
		settingPath: isCommandString(record.settingPath)
			? record.settingPath
			: null,
		severity: doctorString(record, "severity", "info"),
		summary: doctorString(record, "summary", "Unknown finding"),
	};
}

function parseDoctorReport(value: CommandJsonValue): DoctorReportView {
	const record = doctorRecord(value, "report");
	const counts = doctorRecord(record.counts, "counts");
	if (!Array.isArray(record.findings)) {
		throw new Error("Gateway Doctor returned no findings.");
	}
	return {
		counts: {
			errors: doctorCount(counts, "errors"),
			info: doctorCount(counts, "info"),
			warnings: doctorCount(counts, "warnings"),
		},
		findings: record.findings.map(parseDoctorFinding),
		posture: doctorString(record, "posture", "unknown"),
	};
}

function parseDoctorFix(value: CommandJsonValue): DoctorFixView {
	const record = doctorRecord(value, "fix");
	return {
		action: doctorString(record, "action"),
		checkId: doctorString(record, "checkId", "unknown"),
		settingPath: doctorString(record, "settingPath", "unknown"),
		summary: doctorString(record, "summary", "Unknown fix"),
	};
}

function parseDoctorResponse(value: CommandJsonValue): DoctorResponseView {
	const record = doctorRecord(value, "response");
	const planned = Array.isArray(record.plannedFixes)
		? record.plannedFixes.map(parseDoctorFix)
		: [];
	const applied = Array.isArray(record.appliedFixes)
		? record.appliedFixes.map(parseDoctorFix)
		: [];
	const report = parseDoctorReport(record.report ?? record);
	return {
		appliedFixes: applied,
		dryRun: record.dryRun === true,
		plannedFixes: planned,
		report,
	};
}

function renderDoctorResponse(result: DoctorResponseView): string {
	const { counts } = result.report;
	const lines = [
		tf("Gateway Doctor · posture {posture}", {
			posture: result.report.posture,
		}),
		tf(
			"{errors, plural, one {# error} other {# errors}} · {warnings, plural, one {# warning} other {# warnings}} · {info} info",
			{ errors: counts.errors, info: counts.info, warnings: counts.warnings }
		),
		"",
	];

	if (result.report.findings.length === 0) {
		lines.push(
			tr("Healthy — no configuration, security, or performance issues found.")
		);
	} else {
		for (const finding of result.report.findings) {
			lines.push(
				`[${finding.severity}] ${finding.category} · ${finding.summary}`,
				`  ${finding.detail}`
			);
			if (finding.settingPath) {
				lines.push(`  ${tf("setting: {path}", { path: finding.settingPath })}`);
			}
			if (finding.recommendedAction) {
				lines.push(
					`  ${tf("action: {action}", { action: finding.recommendedAction })}`
				);
			}
			lines.push("");
		}
	}

	if (result.plannedFixes.length > 0) {
		lines.push(
			result.dryRun
				? tf("Safe fixes available (dry run — nothing changed): {count}", {
						count: result.plannedFixes.length,
					})
				: tf("Safe fixes planned: {count}", {
						count: result.plannedFixes.length,
					})
		);
		for (const fix of result.plannedFixes) {
			lines.push(`  - ${fix.settingPath}: ${fix.action}`);
		}
		if (result.appliedFixes.length > 0) {
			lines.push(
				tf("Applied: {count, plural, one {# safe fix} other {# safe fixes}}.", {
					count: result.appliedFixes.length,
				})
			);
		}
	} else if (result.report.findings.some((finding) => finding.canAutoFix)) {
		lines.push(
			tr(
				"Safe fixes are available; run `ryu-cli doctor --dry-run` to preview them."
			)
		);
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export const doctorCommand: Command = {
	name: "doctor",
	summary:
		"Audit Gateway configuration and security; 'agents' checks coding-agent MCP setup",
	usage: "ryu-cli doctor [agents] [--fix] [--dry-run] [--json]",
	run: async (ctx) => {
		if (ctx.args[0] === "agents") {
			return await runAgentsDoctor(ctx);
		}
		if (ctx.args[0] !== undefined) {
			throw new UsageError(
				"Usage: ryu-cli doctor [agents] [--fix] [--dry-run] [--json]"
			);
		}
		const previewOrFix = ctx.flags.fix || ctx.flags.dryRun;
		const raw = await callCore(
			ctx,
			previewOrFix ? "/api/gateway/doctor/fix" : "/api/gateway/doctor",
			previewOrFix
				? { method: "POST", body: { dryRun: ctx.flags.dryRun } }
				: { method: "GET" }
		);
		const result = parseDoctorResponse(raw);
		ctx.io.out(
			ctx.flags.json
				? `${JSON.stringify(raw, null, 2)}\n`
				: renderDoctorResponse(result)
		);
		return result.report.counts.errors > 0 ? 1 : 0;
	},
};
