// Language-and-script matching for engines without `Intl.Locale`.
//
// Hermes (React Native) has no `Intl.Locale`, so `maximize()` is unavailable
// and a tag cannot be expanded to its likely script. Matching by language
// alone would hand zh-TW, zh-HK and zh-Hant phones the Simplified Chinese
// catalog, while web, desktop and Core give them English (Ryu ships no
// Traditional Chinese pack). These tables mirror `LIKELY_SCRIPTS` and
// `REGION_SCRIPTS` in `apps/core/src/i18n/locale.rs`; `likely-script.test.ts`
// keeps a copy of Core's values so the two cannot drift silently.

/** The default script of each language with an official catalog. */
export const LIKELY_SCRIPTS: Readonly<Record<string, string>> = {
	ar: "Arab",
	de: "Latn",
	es: "Latn",
	fr: "Latn",
	hi: "Deva",
	it: "Latn",
	ja: "Jpan",
	ko: "Kore",
	pt: "Latn",
	ru: "Cyrl",
	zh: "Hans",
};

/**
 * Regions whose likely script differs from their language's default
 * (Chinese as written in Taiwan, Hong Kong, Macao and most of the diaspora).
 */
export const REGION_SCRIPTS: Readonly<Record<string, Readonly<string[]>>> = {
	zh: [
		"AU",
		"BN",
		"GB",
		"GF",
		"HK",
		"ID",
		"MO",
		"PA",
		"PF",
		"PH",
		"PZ",
		"SR",
		"TH",
		"TW",
		"UK",
		"US",
		"VD",
		"VN",
	],
};

/** The script `REGION_SCRIPTS` regions use. */
const REGION_SCRIPT = "Hant";

const SCRIPT_SUBTAG = /^[A-Za-z]{4}$/u;
const REGION_SUBTAG = /^[A-Za-z]{2}$/u;

function subtagsOf(tag: string): string[] {
	const bare = tag.split(/[.@]/u)[0] ?? "";
	return bare.trim().replaceAll("_", "-").split("-");
}

/** The lowercase primary language of `tag` (`zh_TW.UTF-8` is `zh`). */
export function tagLanguage(tag: string): string {
	return subtagsOf(tag)[0]?.toLowerCase() ?? "";
}

/**
 * The script `tag` is written in: its own four-letter script subtag, else the
 * one its region implies, else its language's default. Null when unknown.
 * `zh-TW` and `zh-Hant-CN` are `Hant`; `zh-SG` and `zh` are `Hans`.
 */
export function likelyScript(tag: string): string | null {
	const [first, ...rest] = subtagsOf(tag);
	const language = first?.toLowerCase() ?? "";
	let region: string | null = null;
	for (const subtag of rest) {
		if (SCRIPT_SUBTAG.test(subtag)) {
			return `${subtag[0]?.toUpperCase() ?? ""}${subtag.slice(1).toLowerCase()}`;
		}
		if (region === null && REGION_SUBTAG.test(subtag)) {
			region = subtag.toUpperCase();
		}
	}
	if (region !== null && REGION_SCRIPTS[language]?.includes(region)) {
		return REGION_SCRIPT;
	}
	return LIKELY_SCRIPTS[language] ?? null;
}

/**
 * The `language-script` key `localeLanguageAndScript` builds from
 * `Intl.Locale#maximize()`, from the tables above: `zh-tw` is `zh-hant`,
 * `pt-PT` is `pt-latn`, and a language without a known script keeps an empty
 * script (`nl-BE` is `nl-`).
 */
export function likelyLanguageAndScript(tag: string): string {
	return `${tagLanguage(tag)}-${(likelyScript(tag) ?? "").toLowerCase()}`;
}

/**
 * The first of `candidates` with the same language and likely script as
 * `tag`, like Core's `locale::resolve`: `pt-PT` finds `pt-BR`, `zh-SG` finds
 * `zh-CN`, and `zh-TW` or `zh-Hant` finds none.
 */
export function matchByLikelyScript(
	tag: string,
	candidates: readonly string[]
): string | null {
	const language = tagLanguage(tag);
	if (!language) {
		return null;
	}
	const script = likelyScript(tag);
	return (
		candidates.find(
			(candidate) =>
				tagLanguage(candidate) === language &&
				likelyScript(candidate) === script
		) ?? null
	);
}
