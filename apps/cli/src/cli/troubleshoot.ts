// `ryu troubleshoot [what went wrong…]` — the end-user auto-debugger.
//
// One command walks the whole path a broken install can fail on and ends in
// either a fix or a useful bug report:
//
//   1. Machine     — OS, CPU, memory, disk, runtime, versions (no hostname).
//   2. Local checks — binaries, data dir, disk space, port/profile mix-ups,
//                     recent log errors. These work while Core is DOWN, which
//                     is exactly when people need them.
//   3. Core checks — health, auth, version skew, runtime readiness, Gateway,
//                     missing sidecar binaries, Gateway/plugin doctor counts.
//   4. Updates     — Core's release verdict, or GitHub's latest release when
//                     Core is unreachable.
//   5. --fix       — the few safe repairs: create the data dir, start a local
//                     Core, apply Gateway Doctor's own safe fixes.
//   6. Report      — redacted Markdown saved under `<data dir>/logs/`, similar
//                     issues from the public tracker, and a GitHub new-issue
//                     link with the bug template prefilled. Nothing is posted:
//                     the user reviews and submits in the browser.
//
// Every side effect goes through {@link TroubleshootHost} so tests run without a
// filesystem, sockets, a browser or the network.

import {
	buildIssueUrl,
	redactDiagnosticText,
	renderTroubleshootMarkdown,
	type TroubleshootReport,
	troubleshootCounts,
} from "@ryuhq/core-client/troubleshoot";
import { isLocal } from "../core/bootstrap.ts";
import { USAGE } from "./troubleshoot-constants.ts";
import { checkCore, checkCoreDetails } from "./troubleshoot-core-checks.ts";
import { checkUpdates } from "./troubleshoot-doctor-updates.ts";
import {
	realTroubleshootHost,
	type TroubleshootHost,
} from "./troubleshoot-host.ts";
import {
	checkBinaries,
	checkDataDir,
	checkLogs,
	checkMemory,
} from "./troubleshoot-local-checks.ts";
import { add, parseOptions, type RunState } from "./troubleshoot-probes.ts";
import {
	findSimilarIssues,
	machineInfo,
	renderHuman,
	saveReport,
	type TroubleshootResult,
} from "./troubleshoot-report.ts";
import type { CliContext, Command } from "./types.ts";
import { VERSION } from "./version.ts";

export type { DirProbe, TroubleshootHost } from "./troubleshoot-host.ts";
export { realTroubleshootHost } from "./troubleshoot-host.ts";
export { extractLogErrors } from "./troubleshoot-probes.ts";

// ── Command ──────────────────────────────────────────────────────────────────

export async function runTroubleshoot(
	ctx: CliContext,
	host: TroubleshootHost
): Promise<number> {
	const options = parseOptions(ctx);
	const target = ctx.target;
	const local = isLocal(target.url);
	const state: RunState = {
		checks: [],
		fixes: [],
		machine: machineInfo(host, ctx),
	};

	add(state, {
		id: "cli.version",
		status: "pass",
		title: "CLI",
		detail: `ryu-cli ${VERSION}.`,
	});
	if (local) {
		await checkDataDir(state, host, options);
	}
	checkMemory(state, host);
	const snapshot = await checkCore(ctx, state, host, target, options);
	// Resolved after `--fix` may have downloaded binaries, shown right after the
	// CLI row so the report reads install → data → Core.
	state.checks.splice(1, 0, ...checkBinaries(host, local));
	await checkCoreDetails(ctx, state, host, target, snapshot, options);
	await checkUpdates(ctx, state, host, target, snapshot, options);
	const logExcerpt = local ? await checkLogs(ctx, state, host) : [];

	const report: TroubleshootReport = {
		checks: state.checks,
		description: redactDiagnosticText(options.description, {
			homeDir: host.homeDir,
		}),
		generatedAt: host.now().toISOString(),
		logExcerpt,
		machine: state.machine,
		similarIssues: [],
		surface: "cli",
		version: VERSION,
	};
	const similar = await findSimilarIssues(report, host, options);
	report.similarIssues = similar.issues;

	const redaction = { homeDir: host.homeDir };
	const issueUrl = buildIssueUrl(report, {
		...redaction,
		fallbackUnit: "apps/cli",
	});
	const reportPath = await saveReport(
		host,
		renderTroubleshootMarkdown(report, { ...redaction, issueUrl })
	);
	const opened = options.open ? await host.openUrl(issueUrl) : false;

	const result: TroubleshootResult = {
		fixes: state.fixes,
		issueUrl,
		opened,
		report,
		reportPath,
		similarIssuesError: similar.error,
	};
	if (options.json) {
		ctx.io.out(
			`${JSON.stringify(
				{
					...result,
					counts: troubleshootCounts(report.checks),
					reportPath: reportPath
						? redactDiagnosticText(reportPath, redaction)
						: null,
				},
				null,
				2
			)}\n`
		);
	} else {
		ctx.io.out(renderHuman(result, host));
	}
	return report.checks.some((check) => check.status === "fail") ? 1 : 0;
}

export const troubleshootCommand: Command = {
	aliases: ["bug-report"],
	name: "troubleshoot",
	summary: "Diagnose this install, apply safe fixes, and prefill a bug report",
	usage: USAGE,
	run: (ctx) =>
		runTroubleshoot(ctx, ctx.troubleshootHost ?? realTroubleshootHost()),
};
