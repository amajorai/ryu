// Which way the visitor's browser chrome reads. The post-download guide points
// at the browser's own download control, and that control follows the
// browser's UI language, not Ryu's: Chrome, Edge and Firefox (and Safari under
// an RTL macOS) mirror their toolbars for an RTL UI, so the control moves to
// the top-left corner. `navigator.language` is the closest signal a page has
// to that UI language.

export type ChromeDirection = "ltr" | "rtl";

/** Primary language subtags whose script is written right to left. */
const RTL_LANGUAGES = new Set([
	"ar",
	"arc",
	"ckb",
	"dv",
	"fa",
	"he",
	"iw",
	"ks",
	"ps",
	"sd",
	"syr",
	"ug",
	"ur",
	"yi",
]);

/** RTL scripts that can be named explicitly in a tag (`pa-Arab`, `az-Arab`). */
const RTL_SCRIPTS = new Set(["arab", "hebr", "syrc", "thaa", "nkoo", "adlm"]);

/** The reading direction of a BCP 47 language tag; LTR when it is unknown. */
export function languageDirection(
	tag: string | null | undefined
): ChromeDirection {
	const parts = (tag ?? "").trim().toLowerCase().split(/[-_]/);
	const [language, second] = parts;
	if (!language) {
		return "ltr";
	}
	if (second && second.length === 4) {
		return RTL_SCRIPTS.has(second) ? "rtl" : "ltr";
	}
	return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * The direction of the browser's own UI, read from `navigator.language`. LTR
 * without a navigator (SSR), which keeps the server render and the common
 * case unchanged.
 */
export function browserChromeDirection(): ChromeDirection {
	if (typeof navigator === "undefined") {
		return "ltr";
	}
	return languageDirection(navigator.language);
}
