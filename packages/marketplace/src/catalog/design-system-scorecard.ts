import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Ryu design-system scorecard rules for UI-bearing apps and plugins.
//
// The scanner only reads bounded source evidence supplied by the catalog host.
// It never executes package code and it deliberately reports missing evidence as
// `unknown` instead of treating an absent source snapshot as a pass.

import {
	buildScorecard,
	check,
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

const SEMANTIC_TOKEN_PATTERN =
	/\b(?:bg|text|border|ring)-(?:background|foreground|card|card-foreground|muted|muted-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|border|input|ring|success|warning|info|destructive)(?:\/[\d.]+)?\b/;
const RAW_COLOR_PATTERN = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i;
const SHARED_IMPORT_PATTERN = /@ryu\/(?:ui|blocks)(?:\/|\b)/;
const INTERACTIVE_PATTERN =
	/<(?:button|input|select|textarea)\b|\b(?:Button|Dialog|Drawer|Sheet|Switch|Checkbox|RadioGroup|Select)\b/;
const ACCESSIBLE_NAME_PATTERN =
	/aria-(?:label|labelledby|describedby)|<Label\b|<FieldLabel\b|role=/;
const STATE_PATTERN =
	/\b(?:disabled|loading|empty|error|offline|unavailable|Spinner|Skeleton|Alert|Empty)\b/i;
const MOTION_PATTERN =
	/\banimate-|\btransition-|\bmotion\.|<motion\.|\banimate=/;
const REDUCED_MOTION_PATTERN =
	/prefers-reduced-motion|respectReducedMotion|useReducedMotion|reducedMotion/;
const LOCAL_FONT_PATTERN = /font-family\s*:|fontFamily\s*:/;
const LOCAL_RADIUS_PATTERN =
	/rounded-\[[^\]]+\]|border-radius\s*:\s*(?!var\(--radius)/i;
const LOCAL_SHELL_PATTERN =
	/\b(?:function|class)\s+(?:Button|Dialog|Modal|Sidebar|AppShell)\b|\b(?:const|let)\s+(?:Button|Dialog|Modal|Sidebar|AppShell)\s*=/;

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
		return "No rendered UI surface is declared; Ryu design-system checks are not applicable to this listing.";
	}
	if (input.surface === "unknown") {
		return "The catalog did not identify whether this listing owns a rendered UI surface.";
	}
	return "The listing has a rendered UI surface, but no bounded source evidence was supplied. It is not treated as compliant by default.";
}

function scopedCheck(
	id: string,
	label: string,
	weight: number,
	status: "fail" | "pass" | "unknown" | "warn",
	detail: string
): ScorecardCheck {
	return check(id, "design-system", label, weight, status, detail);
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
				"Uses the Ryu App UI shell",
				3,
				"pass",
				"The Companion mounts through RyuAppShell and marks its host root."
			);
		}
		if (hasShell || hasRootMarker) {
			return scopedCheck(
				"app-shell",
				"Uses the Ryu App UI shell",
				3,
				"warn",
				"The Companion shows only part of the required Ryu App UI entry contract."
			);
		}
		return scopedCheck(
			"app-shell",
			"Uses the Ryu App UI shell",
			3,
			"fail",
			"No RyuAppShell or companion root marker was found in the supplied UI source."
		);
	}

	if (input.surface === "host") {
		return scopedCheck(
			"app-shell",
			"Uses shared host UI primitives",
			2,
			SHARED_IMPORT_PATTERN.test(text) ? "pass" : "warn",
			SHARED_IMPORT_PATTERN.test(text)
				? "This host-rendered surface imports a shared Ryu UI or Blocks owner."
				: "Host-rendered UI source was supplied without a shared Ryu UI or Blocks import."
		);
	}

	return scopedCheck(
		"app-shell",
		"Uses the Ryu App UI shell",
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
				"Uses the shared theme contract",
				3,
				"pass",
				"The Companion includes app-ui.css and subscribes or marks the host theme."
			);
		}
		if (hasStylesheet || hasRootMarker) {
			return scopedCheck(
				"theme-contract",
				"Uses the shared theme contract",
				3,
				"warn",
				"Only part of the shared stylesheet and host-theme contract is present."
			);
		}
		return scopedCheck(
			"theme-contract",
			"Uses the shared theme contract",
			3,
			"fail",
			"The supplied Companion source does not import @ryu/ui/app-ui.css or the host-theme seam."
		);
	}

	if (input.surface === "host") {
		const hasLocalTheme =
			/(?:^|\n)\s*\.(?:dark|light)\b|--(?:background|foreground|muted)\s*:/m.test(
				text
			);
		return scopedCheck(
			"theme-contract",
			"Uses the shared theme contract",
			2,
			hasLocalTheme ? "warn" : "pass",
			hasLocalTheme
				? "The surface defines local theme tokens or skins; compare them with Ryu's host-owned theme."
				: "No route-local light/dark token block was found in the supplied host surface."
		);
	}

	return scopedCheck(
		"theme-contract",
		"Uses the shared theme contract",
		3,
		"unknown",
		unavailableDetail(input)
	);
}

function primitiveCheck(text: string): ScorecardCheck {
	const hasSharedImport = SHARED_IMPORT_PATTERN.test(text);
	const hasLocalCopy =
		LOCAL_SHELL_PATTERN.test(text) || /role\s*=\s*["']dialog["']/.test(text);
	if (hasSharedImport && !hasLocalCopy) {
		return scopedCheck(
			"shared-primitives",
			"Uses shared controls instead of local copies",
			3,
			"pass",
			"The UI imports Ryu UI/Blocks primitives without an obvious local shell or modal copy."
		);
	}
	if (hasLocalCopy) {
		return scopedCheck(
			"shared-primitives",
			"Uses shared controls instead of local copies",
			3,
			"warn",
			"The source contains a local shell/control or modal pattern; domain-specific renderers should not replace shared interaction owners."
		);
	}
	if (INTERACTIVE_PATTERN.test(text)) {
		return scopedCheck(
			"shared-primitives",
			"Uses shared controls instead of local copies",
			3,
			"fail",
			"Interactive controls were found without a shared Ryu UI or Blocks import in the supplied source."
		);
	}
	return scopedCheck(
		"shared-primitives",
		"Uses shared controls instead of local copies",
		3,
		"unknown",
		"The source evidence does not contain enough control usage to check primitive reuse."
	);
}

function tokenCheck(text: string): ScorecardCheck {
	const hasSemanticTokens = SEMANTIC_TOKEN_PATTERN.test(text);
	const hasRawColors = RAW_COLOR_PATTERN.test(text);
	if (hasRawColors && !hasSemanticTokens) {
		return scopedCheck(
			"semantic-tokens",
			"Uses semantic color tokens",
			2,
			"fail",
			"The supplied UI uses raw color values without an observable semantic token path."
		);
	}
	if (hasRawColors) {
		return scopedCheck(
			"semantic-tokens",
			"Uses semantic color tokens",
			2,
			"warn",
			"Semantic tokens are present, but raw colors also appear; content-specific exceptions should be explicit."
		);
	}
	return scopedCheck(
		"semantic-tokens",
		"Uses semantic color tokens",
		2,
		"pass",
		hasSemanticTokens
			? "The source uses Ryu semantic color utilities or variables."
			: "No route-local raw color values were found; shared primitives can own the surface colors."
	);
}

function typographyCheck(text: string): ScorecardCheck {
	const hasLocalOverrides =
		LOCAL_FONT_PATTERN.test(text) || LOCAL_RADIUS_PATTERN.test(text);
	if (hasLocalOverrides) {
		return scopedCheck(
			"typography-shapes",
			"Keeps typography and shapes on the shared scale",
			2,
			"warn",
			"The source overrides font or radius geometry locally; use Ryu's named roles and radius utilities unless the domain renderer requires an exception."
		);
	}
	return scopedCheck(
		"typography-shapes",
		"Keeps typography and shapes on the shared scale",
		2,
		"pass",
		"No local font-family or arbitrary radius override was found in the supplied UI source."
	);
}

function accessibilityCheck(text: string): ScorecardCheck {
	const hasInteractive = INTERACTIVE_PATTERN.test(text);
	const hasName = ACCESSIBLE_NAME_PATTERN.test(text);
	const hasState = STATE_PATTERN.test(text);
	if (!hasInteractive) {
		return scopedCheck(
			"accessible-states",
			"Covers accessible names and states",
			2,
			"unknown",
			"No interactive control was visible in the supplied source evidence."
		);
	}
	if (hasName && hasState) {
		return scopedCheck(
			"accessible-states",
			"Covers accessible names and states",
			2,
			"pass",
			"The source shows accessible naming plus disabled, loading, empty, or error state vocabulary."
		);
	}
	if (hasName || hasState) {
		return scopedCheck(
			"accessible-states",
			"Covers accessible names and states",
			2,
			"warn",
			"Some accessible or state handling is visible, but the supplied source does not show both sides of the contract."
		);
	}
	return scopedCheck(
		"accessible-states",
		"Covers accessible names and states",
		2,
		"fail",
		"Interactive controls were found without an accessible name or state signal in the supplied source."
	);
}

function motionCheck(text: string): ScorecardCheck {
	const hasMotion = MOTION_PATTERN.test(text);
	const hasReducedMotion = REDUCED_MOTION_PATTERN.test(text);
	if (hasMotion && !hasReducedMotion) {
		return scopedCheck(
			"reduced-motion",
			"Honors reduced motion",
			1,
			"warn",
			"Local motion is present without an observable reduced-motion path; shared motion helpers should own the transition."
		);
	}
	return scopedCheck(
		"reduced-motion",
		"Honors reduced motion",
		1,
		"pass",
		hasReducedMotion
			? "The source includes a reduced-motion hook or media-query path."
			: "No local motion implementation was found; shared primitives can own motion behavior."
	);
}

function stateCoverageCheck(text: string): ScorecardCheck {
	const matches = text.match(new RegExp(STATE_PATTERN.source, "gi")) ?? [];
	if (matches.length >= 3) {
		return scopedCheck(
			"state-coverage",
			"Names loading, empty, error, or unavailable states",
			2,
			"pass",
			"The source names multiple product states that can be rendered explicitly."
		);
	}
	if (matches.length > 0) {
		return scopedCheck(
			"state-coverage",
			"Names loading, empty, error, or unavailable states",
			2,
			"warn",
			"Only one state signal is visible; review loading, empty, error, denied, and unavailable paths for the feature."
		);
	}
	return scopedCheck(
		"state-coverage",
		"Names loading, empty, error, or unavailable states",
		2,
		"unknown",
		"The supplied source does not expose enough state vocabulary to assess the full UI contract."
	);
}

function navigationCheck(
	evidence: DesignSystemEvidence | null | undefined
): ScorecardCheck {
	if (evidence?.navigation === "manifest") {
		return scopedCheck(
			"navigation-owner",
			"Keeps primary navigation host-owned",
			2,
			"pass",
			"Primary navigation is declared through the manifest contribution seam."
		);
	}
	if (evidence?.navigation === "local") {
		return scopedCheck(
			"navigation-owner",
			"Keeps primary navigation host-owned",
			2,
			"warn",
			"The evidence points to a local navigation rail; compare it with manifest-owned Ryu navigation."
		);
	}
	return scopedCheck(
		"navigation-owner",
		"Keeps primary navigation host-owned",
		2,
		"unknown",
		"Navigation ownership was not included in the bounded design-system evidence."
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
				"UI source evidence available",
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
