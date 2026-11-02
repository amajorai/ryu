// Plugin scorecard: maintenance check family (activity, releases, adoption).

import { translate as tl } from "@ryu/i18n/lite";
import { z } from "zod";

import type { CheckStatus, ScorecardCheck } from "./scorecard-contract.ts";
import { agoLabel, check, daysSince } from "./scorecard-contract.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

const RECENT_DAYS = 90;
const STALE_DAYS = 365;
const WELL_ADOPTED_STARS = 25;
const SOME_ADOPTION_STARS = 5;

// Match the existing numeric reports, including exceptional runtime numbers.
const reportNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);

function activityCheck(updated: number | null): ScorecardCheck {
	if (updated === null) {
		return check(
			"activity",
			"maintenance",
			tl("Recently updated"),
			3,
			"unknown",
			tl("This source does not report when it was last updated.")
		);
	}
	const age = agoLabel(updated);
	if (updated <= RECENT_DAYS) {
		return check(
			"activity",
			"maintenance",
			tl("Recently updated"),
			3,
			"pass",
			tl("Last updated {age}.", { age })
		);
	}
	if (updated <= STALE_DAYS) {
		return check(
			"activity",
			"maintenance",
			tl("Recently updated"),
			3,
			"warn",
			tl("Last updated {age}.", { age })
		);
	}
	return check(
		"activity",
		"maintenance",
		tl("Recently updated"),
		3,
		"fail",
		tl("Last updated {age} — likely unmaintained.", { age })
	);
}

function releaseHistoryCheck(count: number | null): ScorecardCheck {
	if (count === null) {
		return check(
			"release-history",
			"maintenance",
			tl("Release history"),
			2,
			"unknown",
			tl("This source does not report a release history.")
		);
	}
	if (count >= 2) {
		return check(
			"release-history",
			"maintenance",
			tl("Release history"),
			2,
			"pass",
			tl(
				"{count, plural, one {# published version} other {# published versions}}.",
				{ count }
			)
		);
	}
	if (count === 1) {
		return check(
			"release-history",
			"maintenance",
			tl("Release history"),
			2,
			"warn",
			tl("Only one version has ever been published.")
		);
	}
	return check(
		"release-history",
		"maintenance",
		tl("Release history"),
		2,
		"fail",
		tl("No versions have been published.")
	);
}

function releaseRecencyDetail(version: string, days: number): string {
	const age = agoLabel(days);
	return version
		? tl("Latest version {version} shipped {age}.", { age, version })
		: tl("Latest version shipped {age}.", { age });
}

function issueTrackerDetail(openIssues: unknown): string {
	const open = reportNumberSchema.safeParse(openIssues);
	if (!open.success) {
		return tl("Issue tracker is open.");
	}
	// Message values must be finite; a NaN/Infinity report reads as written.
	const count = Number.isFinite(open.data) ? open.data : String(open.data);
	return tl("Issue tracker is open ({count} open).", { count });
}

function adoptionDetail(stars: number, wellAdopted: boolean): string {
	if (!Number.isFinite(stars)) {
		const count = String(stars);
		return wellAdopted
			? tl("{count} stars — used by other people.", { count })
			: tl("{count} stars — little independent usage to learn from.", {
					count,
				});
	}
	return wellAdopted
		? tl(
				"{count, plural, one {# star} other {# stars}} — used by other people.",
				{ count: stars }
			)
		: tl(
				"{count, plural, one {# star} other {# stars}} — little independent usage to learn from.",
				{ count: stars }
			);
}

export function maintenanceChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null,
	now: number
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [
		activityCheck(daysSince(detail?.updatedAt, now)),
	];

	if (detail?.archived === true || detail?.disabled === true) {
		checks.push(
			check(
				"archived",
				"maintenance",
				tl("Still active"),
				3,
				"fail",
				tl(
					"The source repository is archived or disabled — it will not receive fixes."
				)
			)
		);
	} else if (detail?.archived === false) {
		checks.push(
			check(
				"archived",
				"maintenance",
				tl("Still active"),
				3,
				"pass",
				tl("The source repository is active.")
			)
		);
	}

	const versions = detail?.versions ?? null;
	checks.push(releaseHistoryCheck(versions === null ? null : versions.length));

	const latestRelease = daysSince(versions?.[0]?.publishedAt, now);
	if (latestRelease !== null) {
		checks.push(
			check(
				"release-recency",
				"maintenance",
				tl("Recent release"),
				1,
				latestRelease <= STALE_DAYS ? "pass" : "warn",
				releaseRecencyDetail(versions?.[0]?.version ?? "", latestRelease)
			)
		);
	}

	const issuesEnabled = z.boolean().safeParse(detail?.issuesEnabled);
	if (issuesEnabled.success) {
		checks.push(
			check(
				"issue-tracker",
				"maintenance",
				tl("Accepts bug reports"),
				1,
				issuesEnabled.data ? "pass" : "warn",
				issuesEnabled.data
					? issueTrackerDetail(detail?.openIssues)
					: tl(
							"The issue tracker is turned off, so there is nowhere to report a bug."
						)
			)
		);
	}

	const stars = detail?.stars ?? entry?.stars ?? null;
	if (reportNumberSchema.safeParse(stars).success && stars !== null) {
		let status: CheckStatus = "warn";
		if (stars >= WELL_ADOPTED_STARS) {
			status = "pass";
		} else if (stars < SOME_ADOPTION_STARS) {
			status = "warn";
		}
		checks.push(
			check(
				"adoption",
				"maintenance",
				tl("Adoption"),
				1,
				status,
				adoptionDetail(stars, stars >= WELL_ADOPTED_STARS)
			)
		);
	}

	return checks;
}
