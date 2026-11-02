// Source-text rules for the Ryu design-system scorecard.
//
// Each rule reads the bounded source snapshot assembled by
// `design-system-scorecard.ts` and reports one design-system check. The rules
// never execute package code.

import { translate as tl } from "@ryu/i18n/lite";
import { check, type ScorecardCheck } from "./scorecard-contract.ts";

const SEMANTIC_TOKEN_PATTERN =
	/\b(?:bg|text|border|ring)-(?:background|foreground|card|card-foreground|muted|muted-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|border|input|ring|success|warning|info|destructive)(?:\/[\d.]+)?\b/;
const RAW_COLOR_PATTERN = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i;
export const SHARED_IMPORT_PATTERN = /@ryu\/(?:ui|blocks)(?:\/|\b)/;
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

export function scopedCheck(
	id: string,
	label: string,
	weight: number,
	status: "fail" | "pass" | "unknown" | "warn",
	detail: string
): ScorecardCheck {
	return check(id, "design-system", label, weight, status, detail);
}

export function primitiveCheck(text: string): ScorecardCheck {
	const hasSharedImport = SHARED_IMPORT_PATTERN.test(text);
	const hasLocalCopy =
		LOCAL_SHELL_PATTERN.test(text) || /role\s*=\s*["']dialog["']/.test(text);
	if (hasSharedImport && !hasLocalCopy) {
		return scopedCheck(
			"shared-primitives",
			tl("Uses shared controls instead of local copies"),
			3,
			"pass",
			tl(
				"The UI imports Ryu UI/Blocks primitives without an obvious local shell or modal copy."
			)
		);
	}
	if (hasLocalCopy) {
		return scopedCheck(
			"shared-primitives",
			tl("Uses shared controls instead of local copies"),
			3,
			"warn",
			tl(
				"The source contains a local shell/control or modal pattern; domain-specific renderers should not replace shared interaction owners."
			)
		);
	}
	if (INTERACTIVE_PATTERN.test(text)) {
		return scopedCheck(
			"shared-primitives",
			tl("Uses shared controls instead of local copies"),
			3,
			"fail",
			tl(
				"Interactive controls were found without a shared Ryu UI or Blocks import in the supplied source."
			)
		);
	}
	return scopedCheck(
		"shared-primitives",
		tl("Uses shared controls instead of local copies"),
		3,
		"unknown",
		tl(
			"The source evidence does not contain enough control usage to check primitive reuse."
		)
	);
}

export function tokenCheck(text: string): ScorecardCheck {
	const hasSemanticTokens = SEMANTIC_TOKEN_PATTERN.test(text);
	const hasRawColors = RAW_COLOR_PATTERN.test(text);
	if (hasRawColors && !hasSemanticTokens) {
		return scopedCheck(
			"semantic-tokens",
			tl("Uses semantic color tokens"),
			2,
			"fail",
			tl(
				"The supplied UI uses raw color values without an observable semantic token path."
			)
		);
	}
	if (hasRawColors) {
		return scopedCheck(
			"semantic-tokens",
			tl("Uses semantic color tokens"),
			2,
			"warn",
			tl(
				"Semantic tokens are present, but raw colors also appear; content-specific exceptions should be explicit."
			)
		);
	}
	return scopedCheck(
		"semantic-tokens",
		tl("Uses semantic color tokens"),
		2,
		"pass",
		hasSemanticTokens
			? tl("The source uses Ryu semantic color utilities or variables.")
			: tl(
					"No route-local raw color values were found; shared primitives can own the surface colors."
				)
	);
}

export function typographyCheck(text: string): ScorecardCheck {
	const hasLocalOverrides =
		LOCAL_FONT_PATTERN.test(text) || LOCAL_RADIUS_PATTERN.test(text);
	if (hasLocalOverrides) {
		return scopedCheck(
			"typography-shapes",
			tl("Keeps typography and shapes on the shared scale"),
			2,
			"warn",
			tl(
				"The source overrides font or radius geometry locally; use Ryu's named roles and radius utilities unless the domain renderer requires an exception."
			)
		);
	}
	return scopedCheck(
		"typography-shapes",
		tl("Keeps typography and shapes on the shared scale"),
		2,
		"pass",
		tl(
			"No local font-family or arbitrary radius override was found in the supplied UI source."
		)
	);
}

export function accessibilityCheck(text: string): ScorecardCheck {
	const hasInteractive = INTERACTIVE_PATTERN.test(text);
	const hasName = ACCESSIBLE_NAME_PATTERN.test(text);
	const hasState = STATE_PATTERN.test(text);
	if (!hasInteractive) {
		return scopedCheck(
			"accessible-states",
			tl("Covers accessible names and states"),
			2,
			"unknown",
			tl("No interactive control was visible in the supplied source evidence.")
		);
	}
	if (hasName && hasState) {
		return scopedCheck(
			"accessible-states",
			tl("Covers accessible names and states"),
			2,
			"pass",
			tl(
				"The source shows accessible naming plus disabled, loading, empty, or error state vocabulary."
			)
		);
	}
	if (hasName || hasState) {
		return scopedCheck(
			"accessible-states",
			tl("Covers accessible names and states"),
			2,
			"warn",
			tl(
				"Some accessible or state handling is visible, but the supplied source does not show both sides of the contract."
			)
		);
	}
	return scopedCheck(
		"accessible-states",
		tl("Covers accessible names and states"),
		2,
		"fail",
		tl(
			"Interactive controls were found without an accessible name or state signal in the supplied source."
		)
	);
}

export function motionCheck(text: string): ScorecardCheck {
	const hasMotion = MOTION_PATTERN.test(text);
	const hasReducedMotion = REDUCED_MOTION_PATTERN.test(text);
	if (hasMotion && !hasReducedMotion) {
		return scopedCheck(
			"reduced-motion",
			tl("Honors reduced motion"),
			1,
			"warn",
			tl(
				"Local motion is present without an observable reduced-motion path; shared motion helpers should own the transition."
			)
		);
	}
	return scopedCheck(
		"reduced-motion",
		tl("Honors reduced motion"),
		1,
		"pass",
		hasReducedMotion
			? tl("The source includes a reduced-motion hook or media-query path.")
			: tl(
					"No local motion implementation was found; shared primitives can own motion behavior."
				)
	);
}

export function stateCoverageCheck(text: string): ScorecardCheck {
	const matches = text.match(new RegExp(STATE_PATTERN.source, "gi")) ?? [];
	if (matches.length >= 3) {
		return scopedCheck(
			"state-coverage",
			tl("Names loading, empty, error, or unavailable states"),
			2,
			"pass",
			tl(
				"The source names multiple product states that can be rendered explicitly."
			)
		);
	}
	if (matches.length > 0) {
		return scopedCheck(
			"state-coverage",
			tl("Names loading, empty, error, or unavailable states"),
			2,
			"warn",
			tl(
				"Only one state signal is visible; review loading, empty, error, denied, and unavailable paths for the feature."
			)
		);
	}
	return scopedCheck(
		"state-coverage",
		tl("Names loading, empty, error, or unavailable states"),
		2,
		"unknown",
		tl(
			"The supplied source does not expose enough state vocabulary to assess the full UI contract."
		)
	);
}
