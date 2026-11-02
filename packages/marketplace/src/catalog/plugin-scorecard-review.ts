// Plugin scorecard: review/provenance and listing-hygiene check families.

import { translate as tl } from "@ryu/i18n/lite";

import type { ScorecardCheck } from "./scorecard-contract.ts";
import { check } from "./scorecard-contract.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

/** Below this, a description is a fragment rather than an explanation. */
const MIN_DESCRIPTION_CHARS = 40;
/** Below this, a README is a stub — a title and an install line. */
const MIN_README_CHARS = 400;

/** Semver with an optional `v` prefix and optional pre-release/build metadata. */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export function reviewChecks(
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
				tl("Reviewed by Ryu"),
				3,
				"pass",
				tl("This listing was vetted before it was published.")
			)
		);
	} else if (reviewed === false) {
		checks.push(
			check(
				"reviewed",
				"review",
				tl("Reviewed by Ryu"),
				3,
				"fail",
				tl(
					"Nobody at Ryu has vetted this listing. It was discovered automatically."
				)
			)
		);
	} else {
		checks.push(
			check(
				"reviewed",
				"review",
				tl("Reviewed by Ryu"),
				3,
				"unknown",
				tl("This source does not report a review status.")
			)
		);
	}

	if (origin) {
		checks.push(
			check(
				"provenance",
				"review",
				tl("Publisher provenance"),
				2,
				community ? "warn" : "pass",
				community
					? tl(
							"Discovered from a public {topic} topic — anyone can publish under it.",
							{ topic: detail?.discoveredFrom?.topic ?? "GitHub" }
						)
					: tl("Published through a first-party channel.")
			)
		);
	}

	if (detail?.descriptorOnly === true || entry?.descriptor_only === true) {
		checks.push(
			check(
				"install-path",
				"review",
				tl("Verified install path"),
				2,
				"warn",
				tl(
					"Listed for discovery only — installing it means fetching code from the repository yourself."
				)
			)
		);
	} else if (detail || entry) {
		checks.push(
			check(
				"install-path",
				"review",
				tl("Verified install path"),
				2,
				"pass",
				tl("Installs through Core's verified install path.")
			)
		);
	}

	const license = detail?.license ?? entry?.license ?? null;
	checks.push(
		license
			? check(
					"license",
					"review",
					tl("Licence declared"),
					2,
					"pass",
					tl("Distributed under {license}.", { license })
				)
			: check(
					"license",
					"review",
					tl("Licence declared"),
					2,
					"fail",
					tl(
						"No licence is declared, so the terms you may use this under are undefined."
					)
				)
	);

	return checks;
}

function descriptionCheck(description: string): ScorecardCheck {
	if (description.trim().length >= MIN_DESCRIPTION_CHARS) {
		return check(
			"description",
			"hygiene",
			tl("Describes what it does"),
			2,
			"pass",
			tl("Carries a full description.")
		);
	}
	if (description.trim()) {
		return check(
			"description",
			"hygiene",
			tl("Describes what it does"),
			2,
			"warn",
			tl(
				"The description is a fragment — too short to explain what installing this does."
			)
		);
	}
	return check(
		"description",
		"hygiene",
		tl("Describes what it does"),
		2,
		"fail",
		tl("No description at all.")
	);
}

function readmeCheck(readme: string): ScorecardCheck {
	if (readme.trim().length >= MIN_README_CHARS) {
		return check(
			"readme",
			"hygiene",
			tl("Documented"),
			2,
			"pass",
			tl("Ships a README with real documentation.")
		);
	}
	if (readme.trim()) {
		return check(
			"readme",
			"hygiene",
			tl("Documented"),
			2,
			"warn",
			tl("The README is a stub.")
		);
	}
	return check(
		"readme",
		"hygiene",
		tl("Documented"),
		2,
		"fail",
		tl("No README was found.")
	);
}

function semverCheck(version: string): ScorecardCheck {
	if (!version.trim()) {
		return check(
			"semver",
			"hygiene",
			tl("Versioned with semver"),
			1,
			"warn",
			tl("No version is published.")
		);
	}
	return SEMVER_RE.test(version.trim())
		? check(
				"semver",
				"hygiene",
				tl("Versioned with semver"),
				1,
				"pass",
				tl("Current version is {version}.", { version })
			)
		: check(
				"semver",
				"hygiene",
				tl("Versioned with semver"),
				1,
				"warn",
				tl(
					'Version "{version}" is not semver, so upgrade compatibility can\'t be reasoned about.',
					{ version }
				)
			);
}

export function hygieneChecks(
	entry: CatalogEntry | null,
	detail: PluginCatalogDetail | null
): ScorecardCheck[] {
	const description = detail?.description ?? entry?.description ?? "";
	const version = detail?.version ?? entry?.version ?? "";
	const readme = detail?.readme ?? "";
	const checks: ScorecardCheck[] = [
		descriptionCheck(description),
		readmeCheck(readme),
		semverCheck(version),
	];

	const surfaces = detail?.surfaces ?? [];
	checks.push(
		surfaces.length > 0
			? check(
					"surfaces",
					"hygiene",
					tl("Declares its platforms"),
					1,
					"pass",
					tl("Declares support for {surfaces}.", {
						surfaces: surfaces.join(", "),
					})
				)
			: check(
					"surfaces",
					"hygiene",
					tl("Declares its platforms"),
					1,
					"warn",
					tl(
						"Declares no platforms, so it is offered on every surface by default."
					)
				)
	);

	const engineReq = detail?.engines?.ryu ?? null;
	checks.push(
		engineReq
			? check(
					"engines",
					"hygiene",
					tl("Pins a Ryu version"),
					1,
					"pass",
					tl("Requires Ryu {requirement}.", { requirement: engineReq })
				)
			: check(
					"engines",
					"hygiene",
					tl("Pins a Ryu version"),
					1,
					"warn",
					tl(
						"Declares no Ryu version requirement, so an incompatible Core won't be caught at install."
					)
				)
	);

	return checks;
}
