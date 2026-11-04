// Plugin Doctor findings rendered from their stable `checkId` on the client.
//
// Core's read-only plugin doctor (`plugin_doctor` in apps/core/src/server/mod.rs)
// returns English summary/detail/action sentences next to a stable check id and
// JSON evidence. The Store's runtime doctor card maps the check id to whole tl()
// messages so they reach the catalog; the one dynamic detail (eval case and
// grader counts) reads its numbers from the evidence. An unknown check id, or
// an eval-file issue whose detail is the eval parser's own message, keeps the
// English Core sent for that field.

import type { LiteralMessage } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";

/** The display fields of a plugin doctor finding, as Core serialises them. */
export interface PluginDoctorFindingSource {
	checkId: string;
	detail: string;
	evidence?: unknown;
	recommendedAction?: string;
	severity: string;
	summary: string;
}

/** The separately translated sentences a finding row shows. */
export interface PluginDoctorFindingCopy {
	action: string;
	detail: string;
	severity: string;
	summary: string;
}

interface PluginCopyEntry {
	action: (tl: LiteralMessage) => string;
	/** `null` when the detail's values could not be read from the evidence. */
	detail: (tl: LiteralMessage, evidence: unknown) => string | null;
	summary: (tl: LiteralMessage) => string;
}

function entry(
	summary: (tl: LiteralMessage) => string,
	detail: (tl: LiteralMessage) => string,
	action: (tl: LiteralMessage) => string
): PluginCopyEntry {
	return { action, detail: (tl) => detail(tl), summary };
}

function evidenceCount(evidence: unknown, key: string): number | null {
	if (typeof evidence !== "object" || evidence === null) {
		return null;
	}
	const value: unknown = Reflect.get(evidence, key);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const disableReenable = (tl: LiteralMessage) =>
	tl(
		"Disable and re-enable the plugin to refresh its approved capability set."
	);

const ENTRIES: Record<string, PluginCopyEntry> = {
	"plugin.not-installed": entry(
		(tl) => tl("Plugin or app is not installed"),
		(tl) =>
			tl(
				"The requested artifact is not present in Core's loaded installed set."
			),
		(tl) => tl("Install the artifact first, then run the doctor again.")
	),
	"manifest.id": entry(
		(tl) => tl("Manifest id is missing"),
		(tl) =>
			tl(
				"Every loaded plugin/app needs a stable id for lifecycle, permissions, and routing."
			),
		(tl) => tl("Set a canonical reverse-domain or scoped id in the manifest.")
	),
	"manifest.name": entry(
		(tl) => tl("Manifest name is missing"),
		(tl) =>
			tl("The Store and lifecycle UI cannot identify this artifact to a user."),
		(tl) => tl("Add a non-empty human-readable name to the manifest.")
	),
	"manifest.version": entry(
		(tl) => tl("Manifest version is missing"),
		(tl) =>
			tl(
				"Core cannot compare upgrades or record a reproducible installed artifact without a version."
			),
		(tl) => tl("Publish a semver version in the manifest.")
	),
	"lifecycle.installed-version": entry(
		(tl) => tl("Installed plugin has no recorded version"),
		(tl) =>
			tl(
				"The lifecycle record and loaded manifest disagree about what is installed."
			),
		(tl) =>
			tl(
				"Reinstall or update the artifact so Core can restore a versioned lifecycle record."
			)
	),
	"permissions.approved-drift": entry(
		(tl) => tl("Enabled plugin has an unapproved declared grant"),
		(tl) =>
			tl(
				"The loaded manifest asks for a capability that is not present in the lifecycle approval record."
			),
		(tl) =>
			tl(
				"Disable and re-enable the plugin through Core so the Gateway can validate its grants again."
			)
	),
	"permissions.stale-approval": entry(
		(tl) => tl("Lifecycle record contains a stale grant"),
		(tl) =>
			tl(
				"A previously approved grant is no longer declared by the loaded manifest."
			),
		disableReenable
	),
	"runtime.safe-mode-suppressed": entry(
		(tl) => tl("Plugin is suppressed by Safe Mode"),
		(tl) =>
			tl(
				"The lifecycle record says enabled, but Core intentionally did not activate it in this boot."
			),
		(tl) =>
			tl(
				"Review the Safe Mode reason before enabling the plugin in a normal boot."
			)
	),
	"dependencies.missing": entry(
		(tl) => tl("Required plugin is not installed"),
		(tl) =>
			tl("The manifest declares a plugin dependency that Core cannot resolve."),
		(tl) => tl("Install the required dependency before enabling this artifact.")
	),
	"dependencies.disabled": entry(
		(tl) => tl("Required plugin is disabled"),
		(tl) =>
			tl(
				"Core can see the dependency, but it is not active for this plugin's runtime contract."
			),
		(tl) =>
			tl(
				"Enable the dependency or disable this artifact until the dependency is ready."
			)
	),
	"manifest.runnable-shape": entry(
		(tl) => tl("Runnable declaration is incomplete"),
		(tl) =>
			tl(
				"Every runnable needs a stable id and kind so Core can register it deterministically."
			),
		(tl) => tl("Add id and kind to the runnable, then reload the manifest.")
	),
	"manifest.duplicate-runnable": entry(
		(tl) => tl("Manifest declares a duplicate runnable id"),
		(tl) =>
			tl(
				"Two contributions share one id and cannot be addressed deterministically."
			),
		(tl) => tl("Give every runnable a unique id within the plugin.")
	),
	"manifest.runnables": entry(
		(tl) => tl("Runnable list is unreadable"),
		(tl) =>
			tl(
				"Core could not reconcile this plugin's declared contributions with the loaded manifest."
			),
		(tl) => tl("Regenerate the packed manifest and run the doctor again.")
	),
	"evals.no-suite": entry(
		(tl) => tl("No package eval suite found"),
		(tl) =>
			tl(
				"This artifact has no evals/ directory, so the doctor can validate its contract but cannot report behavioral coverage."
			),
		(tl) =>
			tl(
				"Add evals/<case>/prompt.md and at least one grader when behavioral regression coverage is useful."
			)
	),
	"evals.empty-suite": entry(
		(tl) => tl("Package eval suite is empty"),
		(tl) =>
			tl("The evals/ directory exists, but it contains no readable cases."),
		(tl) =>
			tl(
				"Add a prompt.md or case.yaml case before relying on behavioral coverage."
			)
	),
	"evals.suite-ready": {
		action: (tl) =>
			tl(
				"Run the explicit plugin/app eval command to collect behavioral evidence."
			),
		detail: (tl, evidence) => {
			const cases = evidenceCount(evidence, "caseCount");
			const graders = evidenceCount(evidence, "graderCount");
			if (cases === null || graders === null) {
				return null;
			}
			return tl(
				"{cases, plural, one {{casesText} case} other {{casesText} cases}} and {graders, plural, one {{gradersText} grader} other {{gradersText} graders}} are available; the read-only doctor did not execute them.",
				{
					cases,
					casesText: formatCount(cases) ?? String(cases),
					graders,
					gradersText: formatCount(graders) ?? String(graders),
				}
			);
		},
		summary: (tl) => tl("Behavioral eval suite discovered"),
	},
};

/** Eval-file issues: Core forwards the eval parser's code and English message. */
const evalIssueEntry: PluginCopyEntry = {
	action: (tl) =>
		tl("Fix the reported eval file and run the plugin doctor again."),
	detail: () => null,
	summary: (tl) => tl("Package eval suite needs attention"),
};

/** Every check id the Store doctor card translates (tests compare it to the Rust). */
export const TRANSLATED_PLUGIN_DOCTOR_CHECK_IDS: readonly string[] =
	Object.keys(ENTRIES);

/** The severity word shown before a finding's summary, in the UI language. */
export function pluginDoctorSeverityLabel(
	severity: string,
	tl: LiteralMessage
): string {
	switch (severity) {
		case "error":
			return tl("Error");
		case "warning":
			return tl("Warning");
		case "info":
			return tl("Info");
		default:
			return severity;
	}
}

function entryFor(checkId: string): PluginCopyEntry | undefined {
	if (Object.hasOwn(ENTRIES, checkId)) {
		return ENTRIES[checkId];
	}
	return checkId.startsWith("evals.") ? evalIssueEntry : undefined;
}

/**
 * The severity, summary, detail and action of `finding` in the UI language;
 * any field this table cannot translate keeps the English Core sent.
 */
export function pluginDoctorFindingCopy(
	finding: PluginDoctorFindingSource,
	tl: LiteralMessage
): PluginDoctorFindingCopy {
	const severity = pluginDoctorSeverityLabel(finding.severity, tl);
	const known = entryFor(finding.checkId);
	if (!known) {
		return {
			action: finding.recommendedAction ?? "",
			detail: finding.detail,
			severity,
			summary: finding.summary,
		};
	}
	return {
		action: known.action(tl),
		detail: known.detail(tl, finding.evidence) ?? finding.detail,
		severity,
		summary: known.summary(tl),
	};
}
