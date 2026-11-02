import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Ryu design-system scorecard rules for UI-bearing apps and plugins.
//
// The scanner only reads bounded source evidence supplied by the catalog host.
// It never executes package code and it deliberately reports missing evidence as
// `unknown` instead of treating an absent source snapshot as a pass.

import { translate as tl } from "@ryu/i18n/lite";
import {
	accessibilityCheck,
	motionCheck,
	primitiveCheck,
	SHARED_IMPORT_PATTERN,
	scopedCheck,
	stateCoverageCheck,
	tokenCheck,
	typographyCheck,
} from "./design-system-scorecard-source-rules.ts";
import {
	buildScorecard,
	type Scorecard,
	type ScorecardCheck,
} from "./scorecard-contract.ts";

export type DesignSystemSurface = "companion" | "host" | "none" | "unknown";
export type DesignSystemNavigation = "local" | "manifest" | "unknown";

export interface DesignSystemFile {
	contents?: string | null;
	path: string;
}

/** Optional, bounded evidence attached to a catalog detail payload. */
export interface DesignSystemEvidence {
	files?: DesignSystemFile[] | null;
	navigation?: DesignSystemNavigation | null;
}

export interface DesignSystemAuditInput {
	evidence?: DesignSystemEvidence | null;
	surface: DesignSystemSurface;
}

const DESIGN_SYSTEM_RULESET_VERSION = "design-system-1" as const;
const MAX_FILES = 64;
const MAX_FILE_CHARS = 24_000;
const SOURCE_FILE_PATTERN = /\.(?:css|html?|jsx?|tsx?|vue|svelte)$/i;

function usableFiles(
	evidence: DesignSystemEvidence | null | undefined
): DesignSystemFile[] {
	return (evidence?.files ?? [])
		.filter(
			(file) =>
				SOURCE_FILE_PATTERN.test(file.path) &&
				isNativeText(file.contents) &&
				file.contents.trim().length > 0
		)
		.slice(0, MAX_FILES)
		.map((file) => ({
			contents: file.contents?.slice(0, MAX_FILE_CHARS),
			path: file.path,
		}));
}

function sourceText(files: DesignSystemFile[]): string {
	return files
		.map((file) => `\n/* ${file.path} */\n${file.contents ?? ""}`)
		.join("\n");
}

function unavailableDetail(input: DesignSystemAuditInput): string {
	if (input.surface === "none") {
		return tl(
			"No rendered UI surface is declared; Ryu design-system checks are not applicable to this listing."
		);
	}
	if (input.surface === "unknown") {
		return tl(
			"The catalog did not identify whether this listing owns a rendered UI surface."
		);
	}
	return tl(
		"The listing has a rendered UI surface, but no bounded source evidence was supplied. It is not treated as compliant by default."
	);
}

function shellCheck(
	input: DesignSystemAuditInput,
	text: string
): ScorecardCheck {
	if (input.surface === "companion") {
		const hasShell =
			text.includes("RyuAppShell") ||
			text.includes("@ryu/blocks/companion/app-ui");
		const hasRootMarker =
			text.includes("markCompanionAppRoot") || text.includes("data-ryu-app-ui");
		if (hasShell && hasRootMarker) {
			return scopedCheck(
				"app-shell",
				tl("Uses the Ryu App UI shell"),
				3,
				"pass",
				tl("The Companion mounts through RyuAppShell and marks its host root.")
			);
		}
		if (hasShell || hasRootMarker) {
			return scopedCheck(
				"app-shell",
				tl("Uses the Ryu App UI shell"),
				3,
				"warn",
				tl(
					"The Companion shows only part of the required Ryu App UI entry contract."
				)
			);
		}
		return scopedCheck(
			"app-shell",
			tl("Uses the Ryu App UI shell"),
			3,
			"fail",
			tl(
				"No RyuAppShell or companion root marker was found in the supplied UI source."
			)
		);
	}

	if (input.surface === "host") {
		return scopedCheck(
			"app-shell",
			tl("Uses shared host UI primitives"),
			2,
			SHARED_IMPORT_PATTERN.test(text) ? "pass" : "warn",
			SHARED_IMPORT_PATTERN.test(text)
				? tl(
						"This host-rendered surface imports a shared Ryu UI or Blocks owner."
					)
				: tl(
						"Host-rendered UI source was supplied without a shared Ryu UI or Blocks import."
					)
		);
	}

	return scopedCheck(
		"app-shell",
		tl("Uses the Ryu App UI shell"),
		3,
		"unknown",
		unavailableDetail(input)
	);
}

function themeCheck(
	input: DesignSystemAuditInput,
	text: string
): ScorecardCheck {
	const hasStylesheet = text.includes("@ryu/ui/app-ui.css");
	const hasRootMarker =
		text.includes("markCompanionAppRoot") ||
		text.includes("subscribeCompanionTheme");
	if (input.surface === "companion") {
		if (hasStylesheet && hasRootMarker) {
			return scopedCheck(
				"theme-contract",
				tl("Uses the shared theme contract"),
				3,
				"pass",
				tl(
					"The Companion includes app-ui.css and subscribes or marks the host theme."
				)
			);
		}
		if (hasStylesheet || hasRootMarker) {
			return scopedCheck(
				"theme-contract",
				tl("Uses the shared theme contract"),
				3,
				"warn",
				tl(
					"Only part of the shared stylesheet and host-theme contract is present."
				)
			);
		}
		return scopedCheck(
			"theme-contract",
			tl("Uses the shared theme contract"),
			3,
			"fail",
			tl(
				"The supplied Companion source does not import @ryu/ui/app-ui.css or the host-theme seam."
			)
		);
	}

	if (input.surface === "host") {
		const hasLocalTheme =
			/(?:^|\n)\s*\.(?:dark|light)\b|--(?:background|foreground|muted)\s*:/m.test(
				text
			);
		return scopedCheck(
			"theme-contract",
			tl("Uses the shared theme contract"),
			2,
			hasLocalTheme ? "warn" : "pass",
			hasLocalTheme
				? tl(
						"The surface defines local theme tokens or skins; compare them with Ryu's host-owned theme."
					)
				: tl(
						"No route-local light/dark token block was found in the supplied host surface."
					)
		);
	}

	return scopedCheck(
		"theme-contract",
		tl("Uses the shared theme contract"),
		3,
		"unknown",
		unavailableDetail(input)
	);
}

function navigationCheck(
	evidence: DesignSystemEvidence | null | undefined
): ScorecardCheck {
	if (evidence?.navigation === "manifest") {
		return scopedCheck(
			"navigation-owner",
			tl("Keeps primary navigation host-owned"),
			2,
			"pass",
			tl(
				"Primary navigation is declared through the manifest contribution seam."
			)
		);
	}
	if (evidence?.navigation === "local") {
		return scopedCheck(
			"navigation-owner",
			tl("Keeps primary navigation host-owned"),
			2,
			"warn",
			tl(
				"The evidence points to a local navigation rail; compare it with manifest-owned Ryu navigation."
			)
		);
	}
	return scopedCheck(
		"navigation-owner",
		tl("Keeps primary navigation host-owned"),
		2,
		"unknown",
		tl(
			"Navigation ownership was not included in the bounded design-system evidence."
		)
	);
}

export function designSystemChecks(
	input: DesignSystemAuditInput
): ScorecardCheck[] {
	const files = usableFiles(input.evidence);
	if (files.length === 0) {
		return [
			scopedCheck(
				"source-evidence",
				tl("UI source evidence available"),
				2,
				"unknown",
				unavailableDetail(input)
			),
		];
	}

	const text = sourceText(files);
	return [
		shellCheck(input, text),
		themeCheck(input, text),
		primitiveCheck(text),
		tokenCheck(text),
		typographyCheck(text),
		accessibilityCheck(text),
		motionCheck(text),
		stateCoverageCheck(text),
		navigationCheck(input.evidence),
	];
}

export function runDesignSystemScorecard(
	input: DesignSystemAuditInput
): Scorecard {
	return buildScorecard(
		designSystemChecks(input),
		DESIGN_SYSTEM_RULESET_VERSION
	);
}
