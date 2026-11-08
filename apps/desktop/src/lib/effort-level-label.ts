// apps/desktop/src/lib/effort-level-label.ts
//
// Reasoning-effort and thinking levels in the UI language. Providers report
// raw ids ("off", "medium", "xhigh"); capitalising them left English words
// inside translated sentences ("Default (Medium)", "Effort: High") and made
// up "Xhigh", which no catalog has. Each known id maps to one literal `tl()`
// call so the extractor sees every label; an unknown id (a provider's own
// level name) is shown as reported.

import { translate } from "@ryu/i18n/core";

/** Any literal translator: `useLiteralMessages()` or the core `translate`. */
export type EffortLabelTranslate = (source: string) => string;

/** "medium" → "Medium" (ja "中"); "xhigh" → "Extra high"; unknown ids pass through. */
export function effortLevelLabel(
	level: string,
	tl: EffortLabelTranslate = translate
): string {
	switch (level.trim().toLowerCase()) {
		case "off":
			return tl("Off");
		case "minimal":
			return tl("Minimal");
		case "low":
			return tl("Low");
		case "medium":
			return tl("Medium");
		case "high":
			return tl("High");
		case "xhigh":
			return tl("Extra high");
		case "max":
			return tl("Max");
		default:
			return level;
	}
}
