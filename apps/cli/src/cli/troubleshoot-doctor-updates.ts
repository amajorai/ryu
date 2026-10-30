// Gateway Doctor (with its safe `--fix`) and the update check.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { ISSUE_REPOSITORY } from "@ryuhq/core-client/troubleshoot";
import { updateCheckResponseSchema } from "@ryuhq/core-client/updates";
import { isNewerCliVersion } from "../core/self-update.ts";
import { tf } from "../i18n/translate.ts";
import {
	CORE_TIMEOUT_MS,
	GITHUB_TIMEOUT_MS,
} from "./troubleshoot-constants.ts";
import type { TroubleshootHost } from "./troubleshoot-host.ts";
import {
	add,
	type CoreSnapshot,
	doctorCountsSchema,
	doctorResponseSchema,
	githubReleaseSchema,
	installCommand,
	probeCore,
	type RunState,
	type TroubleshootOptions,
} from "./troubleshoot-probes.ts";
import type { CliContext } from "./types.ts";
import { VERSION } from "./version.ts";

export async function checkGatewayDoctor(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	options: TroubleshootOptions
): Promise<void> {
	const doctor = await probeCore(
		ctx,
		target,
		"/api/gateway/doctor",
		doctorCountsSchema
	);
	if (!doctor.value) {
		add(state, {
			id: "gateway.doctor",
			status: "skip",
			title: "Gateway Doctor",
			detail: `Unavailable (${doctor.message}).`,
		});
		return;
	}
	let { errors, warnings } = doctor.value.counts;
	const fixable = doctor.value.findings.filter((f) => f.canAutoFix).length;
	if (options.fix && fixable > 0 && ctx.api.call) {
		try {
			const raw = await ctx.api.call(target, "/api/gateway/doctor/fix", {
				method: "POST",
				body: { dryRun: options.dryRun },
				signal: AbortSignal.timeout(CORE_TIMEOUT_MS * 3),
			});
			const result = doctorResponseSchema.parse(raw);
			const count = options.dryRun
				? result.plannedFixes.length
				: result.appliedFixes.length;
			state.fixes.push(
				options.dryRun
					? `Gateway Doctor would apply ${count} safe fix${count === 1 ? "" : "es"}.`
					: `Gateway Doctor applied ${count} safe fix${count === 1 ? "" : "es"}.`
			);
			if (!options.dryRun && result.report) {
				({ errors, warnings } = result.report.counts);
			}
		} catch (error) {
			state.fixes.push(
				`Gateway Doctor fixes failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	add(state, {
		id: "gateway.doctor",
		status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
		title: "Gateway Doctor",
		detail: tf(
			"{errors, plural, one {# error} other {# errors}}, {warnings, plural, one {# warning} other {# warnings}}.",
			{ errors, warnings }
		),
		fix:
			fixable > 0 && !options.fix
				? `Preview safe fixes with \`${host.commandName} doctor --dry-run\`, apply with \`${host.commandName} doctor --fix\`.`
				: `Details: \`${host.commandName} doctor\`.`,
		searchTerms: "gateway doctor",
		unit: "apps/gateway",
	});
}

export async function checkUpdates(
	ctx: CliContext,
	state: RunState,
	host: TroubleshootHost,
	target: ApiTarget,
	snapshot: CoreSnapshot,
	options: TroubleshootOptions
): Promise<void> {
	const fix = `Update: ${installCommand(host)}  (the desktop app updates from Settings › Updates).`;
	if (snapshot.reachable) {
		const verdict = await probeCore(
			ctx,
			target,
			"/api/update/check",
			updateCheckResponseSchema
		);
		const value = verdict.value;
		if (value && !value.error && value.latest) {
			const cliBehind = isNewerCliVersion(value.latest, VERSION);
			const behind = value.update_available || cliBehind;
			add(state, {
				id: "update",
				status: behind ? "warn" : "pass",
				title: "Updates",
				detail: behind
					? tf(
							"Ryu {latest} is available (Core {current}, CLI {VERSION}). Your problem may already be fixed.",
							{ latest: value.latest, current: value.current, VERSION }
						)
					: tf("Up to date on {channel} ({latest}).", {
							channel: value.channel,
							latest: value.latest,
						}),
				fix,
			});
			return;
		}
		if (options.offline) {
			add(state, {
				id: "update",
				status: "skip",
				title: "Updates",
				detail: tf("Core could not check ({error}).", {
					error: value?.error ?? verdict.message,
				}),
			});
			return;
		}
	}
	if (options.offline) {
		add(state, {
			id: "update",
			status: "skip",
			title: "Updates",
			detail: "Skipped (--offline).",
		});
		return;
	}
	try {
		const response = await host.fetch(
			`https://api.github.com/repos/${ISSUE_REPOSITORY}/releases/latest`,
			{
				headers: { Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
			}
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const latest = githubReleaseSchema
			.parse(await response.json())
			.tag_name.replace(/^v/, "");
		const behind = isNewerCliVersion(latest, VERSION);
		add(state, {
			id: "update",
			status: behind ? "warn" : "pass",
			title: "Updates",
			detail: behind
				? tf(
						"Ryu {latest} is available (CLI {VERSION}). Your problem may already be fixed.",
						{ latest, VERSION }
					)
				: tf(
						"No stable release is newer than CLI {VERSION} (latest stable: {latest}).",
						{ VERSION, latest }
					),
			fix,
		});
	} catch (error) {
		add(state, {
			id: "update",
			status: "warn",
			title: "Updates",
			detail: tf("Could not reach GitHub to check for updates ({message}).", {
				message: error instanceof Error ? error.message : String(error),
			}),
			// A network problem on this machine, not a Ryu defect: no unit or
			// search terms, so it never decides where the bug report is filed.
			fix: "Check your internet connection or proxy (HTTPS_PROXY); downloads need it too.",
		});
	}
}
