// Skill-specific marketplace scorecard rules.

import { translate as tl } from "@ryu/i18n/lite";
import type {
	CheckStatus,
	Scorecard,
	ScorecardCheck,
} from "./scorecard-contract.ts";
import {
	agoLabel,
	buildScorecard,
	check,
	daysSince,
} from "./scorecard-contract.ts";
import type { SkillCard, SkillDetail } from "./types.ts";

const RECENT_DAYS = 90;
const STALE_DAYS = 365;
const MIN_DESCRIPTION_CHARS = 40;
const MIN_README_CHARS = 400;
const WELL_ADOPTED_STARS = 25;

function skillTrustChecks(
	card: SkillCard | null,
	detail: SkillDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const trustLevel = card?.trustLevel?.trim().toLowerCase() ?? null;
	const audits = detail?.metadata.securityAudits ?? [];

	checks.push(
		trustLevel === "builtin" || trustLevel === "trusted"
			? check(
					"source-trust",
					"review",
					tl("Registry trust signal"),
					2,
					"pass",
					tl(
						"The source marks this skill as {trustLevel, select, builtin {builtin} other {trusted}}.",
						{ trustLevel }
					)
				)
			: trustLevel === "community"
				? check(
						"source-trust",
						"review",
						tl("Registry trust signal"),
						2,
						"warn",
						tl("The source marks this skill as community-provided.")
					)
				: check(
						"source-trust",
						"review",
						tl("Registry trust signal"),
						2,
						"unknown",
						tl("This source does not publish a trust classification.")
					)
	);

	if (!detail) {
		checks.push(
			check(
				"security-audits",
				"review",
				tl("Published security audits"),
				3,
				"unknown",
				tl("Audits are checked after the skill detail loads.")
			)
		);
	} else if (audits.length === 0) {
		checks.push(
			check(
				"security-audits",
				"review",
				tl("Published security audits"),
				3,
				"warn",
				tl("Nobody has published a security audit for this skill.")
			)
		);
	} else {
		const failed = audits.filter((audit) =>
			["fail", "failed", "high", "critical"].includes(
				audit.status.toLowerCase()
			)
		);
		checks.push(
			check(
				"security-audits",
				"review",
				tl("Published security audits"),
				3,
				failed.length > 0 ? "fail" : "pass",
				failed.length > 0
					? tl(
							"{count, plural, one {# published audit reports} other {# published audits report}} a failing or high-risk status.",
							{ count: failed.length }
						)
					: tl(
							"{count, plural, one {# published audit reports} other {# published audits report}} no failing status.",
							{ count: audits.length }
						)
			)
		);
	}

	return checks;
}

function skillMaintenanceChecks(
	detail: SkillDetail | null,
	now: number
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const pushedAt = detail?.metadata.githubPushedAt ?? null;
	const updatedAt = detail?.metadata.githubUpdatedAt ?? null;
	const lastActivity = pushedAt ?? updatedAt;
	const days = daysSince(lastActivity, now);

	if (days === null) {
		checks.push(
			check(
				"activity",
				"maintenance",
				tl("Recently maintained"),
				2,
				"unknown",
				tl("This source does not publish a repository activity date.")
			)
		);
	} else {
		const status: CheckStatus =
			days <= RECENT_DAYS ? "pass" : days <= STALE_DAYS ? "warn" : "fail";
		checks.push(
			check(
				"activity",
				"maintenance",
				tl("Recently maintained"),
				2,
				status,
				tl("The latest repository activity was {ago}.", { ago: agoLabel(days) })
			)
		);
	}

	const installs = parseSkillCount(detail?.metadata.installs);
	const stars = parseSkillCount(detail?.metadata.githubStars);
	const adoption = Math.max(installs ?? 0, stars ?? 0);
	checks.push(
		adoption >= WELL_ADOPTED_STARS
			? check(
					"adoption",
					"maintenance",
					tl("Has observable adoption"),
					1,
					"pass",
					tl("The source reports meaningful installs or repository adoption.")
				)
			: adoption > 0
				? check(
						"adoption",
						"maintenance",
						tl("Has observable adoption"),
						1,
						"warn",
						tl(
							"The source reports some adoption, but not enough to establish a strong track record."
						)
					)
				: check(
						"adoption",
						"maintenance",
						tl("Has observable adoption"),
						1,
						"unknown",
						tl(
							"This source does not report install or repository adoption counts."
						)
					)
	);

	return checks;
}

function parseSkillCount(value: string | null | undefined): number | null {
	if (!value?.trim()) {
		return null;
	}
	const match = /^([\d,.]+)\s*([km])?$/i.exec(value.trim());
	if (!match) {
		return null;
	}
	const base = Number((match[1] ?? "").replace(/,/g, ""));
	if (!Number.isFinite(base)) {
		return null;
	}
	const multiplier =
		match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1000 : 1;
	return base * multiplier;
}

function skillDisclosureChecks(
	card: SkillCard | null,
	detail: SkillDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const repositoryUrl = detail?.metadata.repositoryUrl ?? null;

	checks.push(
		repositoryUrl
			? check(
					"source",
					"disclosures",
					tl("Source is inspectable"),
					2,
					"pass",
					tl("Links to the repository that publishes this skill.")
				)
			: detail
				? check(
						"source",
						"disclosures",
						tl("Source is inspectable"),
						2,
						"warn",
						tl("The detail does not link to a repository.")
					)
				: check(
						"source",
						"disclosures",
						tl("Source is inspectable"),
						2,
						"unknown",
						tl("The source link is checked after the skill detail loads.")
					)
	);

	checks.push(
		detail
			? check(
					"runtime-permissions",
					"disclosures",
					tl("Runtime permissions"),
					2,
					"pass",
					tl(
						"Skills are instruction packages and declare no plugin runtime permissions."
					)
				)
			: check(
					"runtime-permissions",
					"disclosures",
					tl("Runtime permissions"),
					2,
					"unknown",
					tl("The skill type is checked after the detail loads.")
				)
	);

	checks.push(
		card && detail
			? check(
					"package-files",
					"disclosures",
					tl("Package contents visible"),
					1,
					detail.files.length > 0 ? "pass" : "warn",
					detail.files.length > 0
						? tl(
								"{count, plural, one {# package file is} other {# package files are}} available to inspect.",
								{ count: detail.files.length }
							)
						: tl("The source returned no package files to inspect.")
				)
			: check(
					"package-files",
					"disclosures",
					tl("Package contents visible"),
					1,
					"unknown",
					tl("Package contents are checked after the skill detail loads.")
				)
	);

	return checks;
}

function skillHygieneChecks(
	card: SkillCard | null,
	detail: SkillDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const description = detail?.description ?? card?.description ?? "";
	const readme = detail?.readme ?? "";
	const hasSkillFile = detail?.files.some(
		(file) => file.path.toLowerCase().split("/").at(-1) === "skill.md"
	);

	checks.push(
		description.trim().length >= MIN_DESCRIPTION_CHARS
			? check(
					"description",
					"hygiene",
					tl("Describes what it does"),
					2,
					"pass",
					tl("Carries a full description.")
				)
			: description.trim()
				? check(
						"description",
						"hygiene",
						tl("Describes what it does"),
						2,
						"warn",
						tl(
							"The description is too short to explain what using this skill does."
						)
					)
				: check(
						"description",
						"hygiene",
						tl("Describes what it does"),
						2,
						"fail",
						tl("No description is available.")
					)
	);

	checks.push(
		readme.trim().length >= MIN_README_CHARS
			? check(
					"readme",
					"hygiene",
					tl("Documented"),
					2,
					"pass",
					tl("Ships a README with real documentation.")
				)
			: readme.trim()
				? check(
						"readme",
						"hygiene",
						tl("Documented"),
						2,
						"warn",
						tl("The README is a stub.")
					)
				: detail
					? check(
							"readme",
							"hygiene",
							tl("Documented"),
							2,
							"fail",
							tl("No README was found.")
						)
					: check(
							"readme",
							"hygiene",
							tl("Documented"),
							2,
							"unknown",
							tl("The README is checked after the skill detail loads.")
						)
	);

	checks.push(
		hasSkillFile === true
			? check(
					"skill-file",
					"hygiene",
					tl("Contains SKILL.md"),
					1,
					"pass",
					tl(
						"The package includes the instruction file that defines the skill."
					)
				)
			: hasSkillFile === false
				? check(
						"skill-file",
						"hygiene",
						tl("Contains SKILL.md"),
						1,
						"fail",
						tl("The package does not include a SKILL.md file.")
					)
				: check(
						"skill-file",
						"hygiene",
						tl("Contains SKILL.md"),
						1,
						"unknown",
						tl("Package files are checked after the skill detail loads.")
					)
	);

	return checks;
}

function skillErrorChecks(
	card: SkillCard | null,
	detail: SkillDetail | null
): ScorecardCheck[] {
	if (!detail) {
		return [
			check(
				"content-integrity",
				"errors",
				tl("Package contents read cleanly"),
				3,
				"unknown",
				tl("Package integrity is checked after the skill detail loads.")
			),
		];
	}

	const paths = detail.files.map((file) => file.path.trim());
	const invalidPaths = paths.filter(Boolean).length !== paths.length;
	const duplicatePaths = new Set(paths).size !== paths.length;
	const identityMatches = !card || card.id === detail.card.id;
	return [
		check(
			"content-integrity",
			"errors",
			tl("Package contents read cleanly"),
			3,
			invalidPaths || duplicatePaths ? "fail" : "pass",
			invalidPaths || duplicatePaths
				? tl("The source returned an empty or duplicate file path.")
				: tl("The package file list has unique, non-empty paths.")
		),
		check(
			"identity",
			"errors",
			tl("Listing identity is consistent"),
			2,
			identityMatches ? "pass" : "fail",
			identityMatches
				? tl("The card and detail identify the same skill.")
				: tl("The card and detail identify different skills.")
		),
	];
}

/** Run the skill-specific scorecard over the signals a skill registry exposes.
 *  It deliberately does not reuse plugin permission, route, or manifest checks:
 *  a SKILL.md package has a different safety boundary. */
export function runSkillScorecard(
	card: SkillCard | null,
	detail: SkillDetail | null,
	now: number = Date.now()
): Scorecard {
	const checks = [
		...skillTrustChecks(card, detail),
		...skillDisclosureChecks(card, detail),
		...skillMaintenanceChecks(detail, now),
		...skillHygieneChecks(card, detail),
		...skillErrorChecks(card, detail),
	];

	return buildScorecard(checks, "marketplace-skill-1");
}
