// Shared scorecard contract and deterministic scoring fold.
//
// Rule modules only decide which checks apply to their listing or editor type.
// This module owns the wire shape, category metadata, and scoring semantics
// shared by marketplace listings and agent configuration.

import {
	activeLocale,
	relativeTimeFormatter,
	translate as tl,
} from "@ryu/i18n/lite";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export type ScorecardCategory =
	| "capabilities"
	| "configuration"
	| "design-system"
	| "hygiene"
	| "maintenance"
	| "operations"
	| "review"
	| "runtime"
	| "safety"
	| "disclosures"
	| "errors";

export interface ScorecardCheck {
	category: ScorecardCategory;
	/** Human sentence explaining the verdict — always populated, including for
	 *  `pass`, so the tab reads as a report rather than a row of ticks. */
	detail: string;
	id: string;
	label: string;
	status: CheckStatus;
	/** Relative importance within the total score. */
	weight: number;
}

export interface CategoryScore {
	category: ScorecardCategory;
	fail: number;
	pass: number;
	/** 0–100 within this category, or null when every check was `unknown`. */
	score: number | null;
	unknown: number;
	warn: number;
}

export type ScorecardGrade = "A" | "B" | "C" | "D" | "F";
export type ScorecardRulesetVersion =
	| "agent-config-1"
	| "design-system-1"
	| "marketplace-publish-1"
	| "marketplace-plugin-1"
	| "marketplace-plugin-2"
	| "marketplace-skill-1";

export interface Scorecard {
	categories: CategoryScore[];
	checks: ScorecardCheck[];
	/** How many checks actually counted toward the score. */
	evaluated: number;
	grade: ScorecardGrade | null;
	/** Stable wire metadata so CI and UI can identify the grading rules. */
	rulesetVersion: ScorecardRulesetVersion;
	schemaVersion: "1";
	/** 0–100 over the evaluated checks, or null when nothing was checkable. */
	score: number | null;
	/** One-line verdict for the header badge. */
	summary: string;
}

const CATEGORY_ORDER: ScorecardCategory[] = [
	"configuration",
	"design-system",
	"runtime",
	"safety",
	"capabilities",
	"operations",
	"review",
	"disclosures",
	"maintenance",
	"hygiene",
	"errors",
];

// Getters translate on every read so a rendered heading follows the active
// UI locale instead of the locale that was active when this module loaded.
export const CATEGORY_LABELS = {
	get capabilities() {
		return tl("Capabilities");
	},
	get configuration() {
		return tl("Configuration");
	},
	get "design-system"() {
		return tl("Ryu design system");
	},
	get disclosures() {
		return tl("Disclosures");
	},
	get errors() {
		return tl("Errors");
	},
	get hygiene() {
		return tl("Hygiene");
	},
	get maintenance() {
		return tl("Maintenance");
	},
	get operations() {
		return tl("Operations");
	},
	get review() {
		return tl("Review & provenance");
	},
	get runtime() {
		return tl("Runtime");
	},
	get safety() {
		return tl("Safety");
	},
} satisfies Record<ScorecardCategory, string>;

export const CATEGORY_DESCRIPTIONS = {
	get capabilities() {
		return tl("Whether access, tools, skills, and memory fit the job.");
	},
	get configuration() {
		return tl("Whether the agent has a clear identity and instructions.");
	},
	get "design-system"() {
		return tl(
			"Whether rendered UI evidence uses Ryu's shared shell, tokens, controls, and host ownership."
		);
	},
	get disclosures() {
		return tl("What it tells you about the data and access it wants.");
	},
	get errors() {
		return tl("Problems found while reading the listing itself.");
	},
	get hygiene() {
		return tl("Whether the listing is complete and correctly described.");
	},
	get maintenance() {
		return tl("Whether anyone is still looking after it.");
	},
	get operations() {
		return tl("Whether background work has the prerequisites it needs.");
	},
	get review() {
		return tl("Who published it and who checked it.");
	},
	get runtime() {
		return tl("Whether the selected runtime and model can start.");
	},
	get safety() {
		return tl("Whether execution posture matches the access it has.");
	},
} satisfies Record<ScorecardCategory, string>;

const STATUS_POINTS = {
	fail: 0,
	pass: 1,
	unknown: 0,
	warn: 0.5,
} satisfies Record<CheckStatus, number>;

/** Weighted points a check contributes. `unknown` never reaches here — it is
 * filtered out of both the numerator and the denominator. */
function points(check_: ScorecardCheck): number {
	return check_.weight * STATUS_POINTS[check_.status];
}

/** Whole days since an ISO timestamp, or null when it is absent/unparseable.
 * `now` is injected so the checks are deterministic under test. */
export function daysSince(
	iso: string | null | undefined,
	now: number
): number | null {
	if (!iso) {
		return null;
	}
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return Math.floor((now - parsed) / (24 * 60 * 60 * 1000));
}

/** Format a day count the way the detail rows read best, in the UI locale:
 * "today", "yesterday", "12 days ago", "3 months ago", "1.5 years ago". The
 * unit choice is fixed so every locale rounds the same age the same way. */
export function agoLabel(
	days: number,
	locale: string = activeLocale()
): string {
	if (days <= 0) {
		return relativeTimeFormatter(locale).format(0, "day");
	}
	if (days < 60) {
		return relativeTimeFormatter(locale).format(-days, "day");
	}
	const counted = relativeTimeFormatter(locale, "long", "always");
	if (days < 365) {
		return counted.format(-Math.round(days / 30), "month");
	}
	return counted.format(-Number((days / 365).toFixed(1)), "year");
}

export function check(
	id: string,
	category: ScorecardCategory,
	label: string,
	weight: number,
	status: CheckStatus,
	detail: string
): ScorecardCheck {
	return { category, detail, id, label, status, weight };
}

/** Roll a check list up into per-category scores, preserving display order. */
function summarizeCategories(checks: ScorecardCheck[]): CategoryScore[] {
	return CATEGORY_ORDER.filter((category) =>
		checks.some((c) => c.category === category)
	).map((category) => {
		const inCategory = checks.filter((c) => c.category === category);
		const scored = inCategory.filter((c) => c.status !== "unknown");
		const earned = scored.reduce((sum, c) => sum + points(c), 0);
		const possible = scored.reduce((sum, c) => sum + c.weight, 0);
		return {
			category,
			fail: inCategory.filter((c) => c.status === "fail").length,
			pass: inCategory.filter((c) => c.status === "pass").length,
			score: possible > 0 ? Math.round((earned / possible) * 100) : null,
			unknown: inCategory.filter((c) => c.status === "unknown").length,
			warn: inCategory.filter((c) => c.status === "warn").length,
		};
	});
}

function gradeFor(score: number): ScorecardGrade {
	if (score >= 90) {
		return "A";
	}
	if (score >= 75) {
		return "B";
	}
	if (score >= 60) {
		return "C";
	}
	if (score >= 40) {
		return "D";
	}
	return "F";
}

function summaryFor(
	score: number | null,
	failures: number,
	warnings: number,
	rulesetVersion: ScorecardRulesetVersion
): string {
	if (score === null) {
		return rulesetVersion === "agent-config-1"
			? tl("Not enough information to assess this agent yet.")
			: tl("Not enough information to assess this listing.");
	}
	if (failures > 0) {
		return rulesetVersion === "agent-config-1"
			? tl(
					"{failures, plural, one {# failed check} other {# failed checks}} — fix them before running this agent.",
					{ failures }
				)
			: tl(
					"{failures, plural, one {# failed check} other {# failed checks}} — read them before installing.",
					{ failures }
				);
	}
	if (warnings > 0) {
		return tl(
			"Passes every critical check, with {warnings, plural, one {# thing} other {# things}} worth knowing.",
			{ warnings }
		);
	}
	return tl("Passes every automated check.");
}

export function buildScorecard(
	checks: ScorecardCheck[],
	rulesetVersion: ScorecardRulesetVersion
): Scorecard {
	const scored = checks.filter((c) => c.status !== "unknown");
	const earned = scored.reduce((sum, c) => sum + points(c), 0);
	const possible = scored.reduce((sum, c) => sum + c.weight, 0);
	const score = possible > 0 ? Math.round((earned / possible) * 100) : null;

	return {
		categories: summarizeCategories(checks),
		checks,
		evaluated: scored.length,
		grade: score === null ? null : gradeFor(score),
		rulesetVersion,
		schemaVersion: "1",
		score,
		summary: summaryFor(
			score,
			checks.filter((c) => c.status === "fail").length,
			checks.filter((c) => c.status === "warn").length,
			rulesetVersion
		),
	};
}
