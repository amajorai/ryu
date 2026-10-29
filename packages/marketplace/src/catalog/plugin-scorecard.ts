// Plugin-specific marketplace scorecard rules.

import { z } from "zod";

import {
	type DesignSystemSurface,
	designSystemChecks,
} from "./design-system-scorecard.ts";
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
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

const RECENT_DAYS = 90;
const STALE_DAYS = 365;
/** Below this, a description is a fragment rather than an explanation. */
const MIN_DESCRIPTION_CHARS = 40;
/** Below this, a README is a stub — a title and an install line. */
const MIN_README_CHARS = 400;
const WELL_ADOPTED_STARS = 25;
const SOME_ADOPTION_STARS = 5;

function designSystemSurface(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): DesignSystemSurface {
	const api = detail?.apiSurface;
	const hasCompanion =
		entry?.type === "app" ||
		entry?.kinds.includes("companion") === true ||
		detail?.runnables?.some((runnable) => runnable.kind === "companion") ===
			true ||
		api?.runnables?.some((runnable) => runnable.kind === "companion") === true;
	if (hasCompanion) {
		return "companion";
	}
	const hasHostSurface =
		(api?.views?.length ?? 0) > 0 ||
		(api?.settingsTabs?.length ?? 0) > 0 ||
		(api?.composerControls?.length ?? 0) > 0;
	if (hasHostSurface) {
		return "host";
	}
	if (api) {
		return "none";
	}
	return "unknown";
}

/** Semver with an optional `v` prefix and optional pre-release/build metadata. */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** Reserved first-party id namespaces. A community listing whose manifest claims
 *  one of these is impersonating Ryu, which is a hard failure, not a warning. */
const RESERVED_ID_PREFIXES = [
	"@ryu/",
	"@amajor/",
	"com.ryu.",
	"ai.ryu.",
	"com.amajor.",
];

/** True when the permission summary declares an unscoped capability — the shape
 * the breadth check treats as "asks for everything of this kind". */
const permissionArraySchema = z.custom<unknown[]>(Array.isArray);
const permissionObjectSchema = z.record(z.string(), z.unknown());
// Keep the original key bag: decoding a record discards an own __proto__ key.
const permissionObjectBoundarySchema = z.custom<
	z.infer<typeof permissionObjectSchema>
>((value) => permissionObjectSchema.safeParse(value).success);
const broadPermissionSchema = z.unknown().transform((value) => {
	if (value === true) {
		return true;
	}
	const record = permissionObjectBoundarySchema.safeParse(value);
	if (record.success) {
		return Object.values(record.data).some((permission) => {
			const list = permissionArraySchema.safeParse(permission);
			return (
				permission === true ||
				permission === "*" ||
				(list.success && list.data.includes("*"))
			);
		});
	}
	const list = permissionArraySchema.safeParse(value);
	return list.success && list.data.includes("*");
});
const isBroad = broadPermissionSchema.parse;
// Match the existing numeric reports, including exceptional runtime numbers.
const reportNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);

// ── Check families ──────────────────────────────────────────────────────────
//
// Each builder takes the normalized inputs and returns its checks. Split by
// family so a category can be reasoned about (and tested) on its own.

function reviewChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const origin = detail?.origin ?? entry?.origin ?? null;
	const community = origin === "community";
	const reviewed = detail?.reviewed ?? entry?.reviewed;

	if (reviewed === true) {
		checks.push(
			check(
				"reviewed",
				"review",
				"Reviewed by Ryu",
				3,
				"pass",
				"This listing was vetted before it was published."
			)
		);
	} else if (reviewed === false) {
		checks.push(
			check(
				"reviewed",
				"review",
				"Reviewed by Ryu",
				3,
				"fail",
				"Nobody at Ryu has vetted this listing. It was discovered automatically."
			)
		);
	} else {
		checks.push(
			check(
				"reviewed",
				"review",
				"Reviewed by Ryu",
				3,
				"unknown",
				"This source does not report a review status."
			)
		);
	}

	if (origin) {
		checks.push(
			check(
				"provenance",
				"review",
				"Publisher provenance",
				2,
				community ? "warn" : "pass",
				community
					? `Discovered from a public ${detail?.discoveredFrom?.topic ?? "GitHub"} topic — anyone can publish under it.`
					: "Published through a first-party channel."
			)
		);
	}

	if (detail?.descriptorOnly === true || entry?.descriptor_only === true) {
		checks.push(
			check(
				"install-path",
				"review",
				"Verified install path",
				2,
				"warn",
				"Listed for discovery only — installing it means fetching code from the repository yourself."
			)
		);
	} else if (detail || entry) {
		checks.push(
			check(
				"install-path",
				"review",
				"Verified install path",
				2,
				"pass",
				"Installs through Core's verified install path."
			)
		);
	}

	const license = detail?.license ?? entry?.license ?? null;
	checks.push(
		license
			? check(
					"license",
					"review",
					"Licence declared",
					2,
					"pass",
					`Distributed under ${license}.`
				)
			: check(
					"license",
					"review",
					"Licence declared",
					2,
					"fail",
					"No licence is declared, so the terms you may use this under are undefined."
				)
	);

	return checks;
}

function hygieneChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const description = detail?.description ?? entry?.description ?? "";
	const version = detail?.version ?? entry?.version ?? "";
	const readme = detail?.readme ?? "";

	if (description.trim().length >= MIN_DESCRIPTION_CHARS) {
		checks.push(
			check(
				"description",
				"hygiene",
				"Describes what it does",
				2,
				"pass",
				"Carries a full description."
			)
		);
	} else if (description.trim()) {
		checks.push(
			check(
				"description",
				"hygiene",
				"Describes what it does",
				2,
				"warn",
				"The description is a fragment — too short to explain what installing this does."
			)
		);
	} else {
		checks.push(
			check(
				"description",
				"hygiene",
				"Describes what it does",
				2,
				"fail",
				"No description at all."
			)
		);
	}

	if (readme.trim().length >= MIN_README_CHARS) {
		checks.push(
			check(
				"readme",
				"hygiene",
				"Documented",
				2,
				"pass",
				"Ships a README with real documentation."
			)
		);
	} else if (readme.trim()) {
		checks.push(
			check(
				"readme",
				"hygiene",
				"Documented",
				2,
				"warn",
				"The README is a stub."
			)
		);
	} else {
		checks.push(
			check(
				"readme",
				"hygiene",
				"Documented",
				2,
				"fail",
				"No README was found."
			)
		);
	}

	if (version.trim()) {
		checks.push(
			SEMVER_RE.test(version.trim())
				? check(
						"semver",
						"hygiene",
						"Versioned with semver",
						1,
						"pass",
						`Current version is ${version}.`
					)
				: check(
						"semver",
						"hygiene",
						"Versioned with semver",
						1,
						"warn",
						`Version "${version}" is not semver, so upgrade compatibility can't be reasoned about.`
					)
		);
	} else {
		checks.push(
			check(
				"semver",
				"hygiene",
				"Versioned with semver",
				1,
				"warn",
				"No version is published."
			)
		);
	}

	const surfaces = detail?.surfaces ?? [];
	checks.push(
		surfaces.length > 0
			? check(
					"surfaces",
					"hygiene",
					"Declares its platforms",
					1,
					"pass",
					`Declares support for ${surfaces.join(", ")}.`
				)
			: check(
					"surfaces",
					"hygiene",
					"Declares its platforms",
					1,
					"warn",
					"Declares no platforms, so it is offered on every surface by default."
				)
	);

	const engineReq = detail?.engines?.ryu ?? null;
	checks.push(
		engineReq
			? check(
					"engines",
					"hygiene",
					"Pins a Ryu version",
					1,
					"pass",
					`Requires Ryu ${engineReq}.`
				)
			: check(
					"engines",
					"hygiene",
					"Pins a Ryu version",
					1,
					"warn",
					"Declares no Ryu version requirement, so an incompatible Core won't be caught at install."
				)
	);

	return checks;
}

function maintenanceChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null,
	now: number
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const updated = daysSince(detail?.updatedAt, now);

	if (updated === null) {
		checks.push(
			check(
				"activity",
				"maintenance",
				"Recently updated",
				3,
				"unknown",
				"This source does not report when it was last updated."
			)
		);
	} else if (updated <= RECENT_DAYS) {
		checks.push(
			check(
				"activity",
				"maintenance",
				"Recently updated",
				3,
				"pass",
				`Last updated ${agoLabel(updated)}.`
			)
		);
	} else if (updated <= STALE_DAYS) {
		checks.push(
			check(
				"activity",
				"maintenance",
				"Recently updated",
				3,
				"warn",
				`Last updated ${agoLabel(updated)}.`
			)
		);
	} else {
		checks.push(
			check(
				"activity",
				"maintenance",
				"Recently updated",
				3,
				"fail",
				`Last updated ${agoLabel(updated)} — likely unmaintained.`
			)
		);
	}

	if (detail?.archived === true || detail?.disabled === true) {
		checks.push(
			check(
				"archived",
				"maintenance",
				"Still active",
				3,
				"fail",
				"The source repository is archived or disabled — it will not receive fixes."
			)
		);
	} else if (detail?.archived === false) {
		checks.push(
			check(
				"archived",
				"maintenance",
				"Still active",
				3,
				"pass",
				"The source repository is active."
			)
		);
	}

	const versions = detail?.versions ?? null;
	if (versions === null) {
		checks.push(
			check(
				"release-history",
				"maintenance",
				"Release history",
				2,
				"unknown",
				"This source does not report a release history."
			)
		);
	} else if (versions.length >= 2) {
		checks.push(
			check(
				"release-history",
				"maintenance",
				"Release history",
				2,
				"pass",
				`${versions.length} published versions.`
			)
		);
	} else if (versions.length === 1) {
		checks.push(
			check(
				"release-history",
				"maintenance",
				"Release history",
				2,
				"warn",
				"Only one version has ever been published."
			)
		);
	} else {
		checks.push(
			check(
				"release-history",
				"maintenance",
				"Release history",
				2,
				"fail",
				"No versions have been published."
			)
		);
	}

	const latestRelease = daysSince(versions?.[0]?.publishedAt, now);
	if (latestRelease !== null) {
		checks.push(
			check(
				"release-recency",
				"maintenance",
				"Recent release",
				1,
				latestRelease <= STALE_DAYS ? "pass" : "warn",
				`Latest version ${versions?.[0]?.version ?? ""} shipped ${agoLabel(latestRelease)}.`.trim()
			)
		);
	}

	const issuesEnabled = z.boolean().safeParse(detail?.issuesEnabled);
	if (issuesEnabled.success) {
		checks.push(
			check(
				"issue-tracker",
				"maintenance",
				"Accepts bug reports",
				1,
				issuesEnabled.data ? "pass" : "warn",
				issuesEnabled.data
					? `Issue tracker is open${reportNumberSchema.safeParse(detail?.openIssues).success ? ` (${detail?.openIssues} open)` : ""}.`
					: "The issue tracker is turned off, so there is nowhere to report a bug."
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
				"Adoption",
				1,
				status,
				stars >= WELL_ADOPTED_STARS
					? `${stars} stars — used by other people.`
					: `${stars} stars — little independent usage to learn from.`
			)
		);
	}

	return checks;
}

function disclosureChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];
	const permissions = detail?.permissions ?? null;
	const grants = detail?.permissionGrants ?? entry?.requires?.grants ?? [];
	const reachesNetwork =
		isBroad(permissions?.network) ||
		grants.some((g) => /net|web|http|fetch/i.test(g));

	checks.push(
		detail?.privacyPolicyUrl
			? check(
					"privacy-policy",
					"disclosures",
					"Privacy policy",
					2,
					"pass",
					"Publishes a privacy policy."
				)
			: check(
					"privacy-policy",
					"disclosures",
					"Privacy policy",
					2,
					reachesNetwork ? "fail" : "warn",
					reachesNetwork
						? "No privacy policy, and this plugin can reach the network with your data."
						: "No privacy policy is published."
				)
	);

	checks.push(
		detail?.termsOfServiceUrl
			? check(
					"terms",
					"disclosures",
					"Terms of service",
					1,
					"pass",
					"Publishes terms of service."
				)
			: check(
					"terms",
					"disclosures",
					"Terms of service",
					1,
					"warn",
					"No terms of service are published."
				)
	);

	if (permissions?.declared === true) {
		const broad = [
			isBroad(permissions.network) ? "network" : null,
			isBroad(permissions.fs) ? "filesystem" : null,
			isBroad(permissions.childProcess) ? "subprocesses" : null,
		].filter((value) => value !== null);
		checks.push(
			broad.length === 0
				? check(
						"permission-breadth",
						"disclosures",
						"Narrow permissions",
						3,
						"pass",
						"Every runtime permission it requests is scoped."
					)
				: check(
						"permission-breadth",
						"disclosures",
						"Narrow permissions",
						3,
						"warn",
						`Requests unrestricted ${broad.join(", ")} access.`
					)
		);
	} else if (detail) {
		checks.push(
			check(
				"permission-breadth",
				"disclosures",
				"Narrow permissions",
				3,
				"pass",
				"Declares no runtime permissions, so it runs fully sandboxed."
			)
		);
	}

	const publicRoutes = (detail?.apiSurface?.sidecars ?? []).flatMap((s) =>
		(s.routes ?? []).filter((r) => r.auth === "none" || r.auth === "public")
	);
	if (detail?.apiSurface?.sidecars?.length) {
		checks.push(
			publicRoutes.length === 0
				? check(
						"network-surface",
						"disclosures",
						"Authenticated endpoints",
						2,
						"pass",
						"Every HTTP route its background service exposes requires authentication."
					)
				: check(
						"network-surface",
						"disclosures",
						"Authenticated endpoints",
						2,
						"warn",
						`${publicRoutes.length} HTTP route(s) are exposed without authentication.`
					)
		);
	}

	const homepage =
		detail?.website ?? detail?.repositoryUrl ?? entry?.repo_url ?? null;
	checks.push(
		homepage
			? check(
					"homepage",
					"disclosures",
					"Source is inspectable",
					1,
					"pass",
					"Links to a homepage or repository you can read."
				)
			: check(
					"homepage",
					"disclosures",
					"Source is inspectable",
					1,
					"warn",
					"Links to no homepage or repository."
				)
	);

	return checks;
}

function errorChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const checks: ScorecardCheck[] = [];

	if (detail?.enrichmentError) {
		checks.push(
			check(
				"enrichment",
				"errors",
				"Listing reads cleanly",
				3,
				"fail",
				detail.enrichmentError
			)
		);
	} else if (detail) {
		checks.push(
			check(
				"enrichment",
				"errors",
				"Listing reads cleanly",
				3,
				"pass",
				"The listing and its manifest were read without errors."
			)
		);
	}

	// An id-squatting community listing: its manifest claims a reserved
	// first-party namespace. Hard fail — this is impersonation, not sloppiness.
	const claimedId = detail?.manifestId ?? null;
	const origin = detail?.origin ?? entry?.origin ?? null;
	if (claimedId && origin === "community") {
		const squatting = RESERVED_ID_PREFIXES.some((p) =>
			claimedId.toLowerCase().startsWith(p)
		);
		checks.push(
			squatting
				? check(
						"identity",
						"errors",
						"Identity is its own",
						3,
						"fail",
						`Its manifest claims the reserved id "${claimedId}", impersonating a first-party plugin.`
					)
				: check(
						"identity",
						"errors",
						"Identity is its own",
						3,
						"pass",
						`Publishes under its own id "${claimedId}".`
					)
		);
	}

	const surface = detail?.apiSurface ?? null;
	if (surface) {
		const contributions = [
			...(surface.commands ?? []),
			...(surface.tools ?? []),
			...(surface.agents ?? []),
			...(surface.workflows ?? []),
			...(surface.policies ?? []),
		];
		const dangling = contributions.filter((c) => !c.name);
		if (contributions.length > 0) {
			checks.push(
				dangling.length === 0
					? check(
							"manifest-integrity",
							"errors",
							"Contributions resolve",
							2,
							"pass",
							"Every declared contribution points at something this plugin ships."
						)
					: check(
							"manifest-integrity",
							"errors",
							"Contributions resolve",
							2,
							"warn",
							`${dangling.length} declared contribution(s) reference something the plugin does not ship.`
						)
			);
		}
	}

	return checks;
}

/**
 * Run the full automated scan over a plugin listing.
 *
 * Both inputs are optional and the result is always well-formed: a listing with
 * no detail loaded yet still scores what the card alone can answer, so the badge
 * does not pop in and out while the detail request is in flight.
 *
 * `now` is injectable purely so the maintenance checks are deterministic in
 * tests; callers should omit it.
 */
export function runScorecard(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null,
	now: number = Date.now()
): Scorecard {
	const checks = [
		...reviewChecks(entry, detail),
		...disclosureChecks(entry, detail),
		...maintenanceChecks(entry, detail, now),
		...hygieneChecks(entry, detail),
		...errorChecks(entry, detail),
		...designSystemChecks({
			evidence: detail?.designSystem,
			surface: designSystemSurface(entry, detail),
		}),
	];
	return buildScorecard(checks, "marketplace-plugin-2");
}
