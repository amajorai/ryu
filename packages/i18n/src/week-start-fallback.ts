// First weekday for engines without `Intl.Locale` (Hermes in React Native),
// where `weekStartForLocale` cannot read Intl week data. The region lists
// follow CLDR's `weekData` `firstDay` as ICU reports it; every other region
// starts on Monday. A tag without a region uses its language's likely region,
// known only for English and the official catalog languages.

/** First day of the week, `Date#getDay()` style: 0 is Sunday, 1 Monday. */
type FirstWeekday = 0 | 1 | 5 | 6;

const FRIDAY_REGIONS = new Set(["MV"]);

const SATURDAY_REGIONS = new Set(
	"AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" ")
);

const SUNDAY_REGIONS = new Set(
	[
		"AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN IS JM JP KE",
		"KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW",
		"UM US VE VI WS YE ZA ZW",
	]
		.join(" ")
		.split(" ")
);

/** The region a bare language tag implies (`ar` is Egypt, `pt` Brazil). */
const LIKELY_REGIONS: Readonly<Record<string, string>> = {
	ar: "EG",
	de: "DE",
	en: "US",
	es: "ES",
	fr: "FR",
	hi: "IN",
	it: "IT",
	ja: "JP",
	ko: "KR",
	pt: "BR",
	ru: "RU",
	zh: "CN",
};

/** A well-formed BCP 47 shape: a 2-3 letter language, then 1-8 char subtags. */
const LOCALE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;
const REGION_SUBTAG = /^(?:[A-Za-z]{2}|\d{3})$/u;
const SCRIPT_SUBTAG = /^[A-Za-z]{4}$/u;

function regionOf(subtags: readonly string[]): string | undefined {
	const [language = "", ...rest] = subtags;
	for (const subtag of rest) {
		if (subtag.length === 1) {
			break;
		}
		if (REGION_SUBTAG.test(subtag)) {
			return subtag.toUpperCase();
		}
	}
	const lowered = language.toLowerCase();
	const script = rest.find((subtag) => SCRIPT_SUBTAG.test(subtag));
	if (lowered === "zh" && script?.toLowerCase() === "hant") {
		return "TW";
	}
	return LIKELY_REGIONS[lowered];
}

/**
 * The first weekday `locale` uses, from the CLDR tables above: 1 for `de`,
 * 6 for `ar`, 0 for `en-US` and `zh-Hant`. Undefined for a malformed tag or a
 * bare language whose region is unknown, so callers keep their own default.
 */
export function fallbackWeekStart(locale: string): FirstWeekday | undefined {
	const tag = locale.trim().replaceAll("_", "-");
	if (!LOCALE_SHAPE.test(tag)) {
		return;
	}
	const region = regionOf(tag.split("-"));
	if (region === undefined) {
		return;
	}
	if (SUNDAY_REGIONS.has(region)) {
		return 0;
	}
	if (SATURDAY_REGIONS.has(region)) {
		return 6;
	}
	return FRIDAY_REGIONS.has(region) ? 5 : 1;
}
