import { directionForLocale } from "./locale.ts";

/**
 * Bidi isolation for the values `formatMessage` puts into a sentence.
 *
 * In a right-to-left sentence a Latin value (a path, an email, `@alice`,
 * `#general`) lets its neutral edge characters take the paragraph direction:
 * `@{handle}` shows as `alice@`, `"{path}"` as `agents/."`. Wrapping the value
 * in FSI ... PDI (U+2068 ... U+2069) lays it out on its own, by its first
 * strong character, without changing the sentence around it. Only RTL locales
 * get the isolates, so left-to-right output is byte-identical to before.
 */

/** U+2068 FIRST STRONG ISOLATE: the value takes its own first strong direction. */
export const FIRST_STRONG_ISOLATE = String.fromCodePoint(0x20_68);
/** U+2066 LEFT-TO-RIGHT ISOLATE: the value is always laid out left to right. */
export const LEFT_TO_RIGHT_ISOLATE = String.fromCodePoint(0x20_66);
/** U+2069 POP DIRECTIONAL ISOLATE: closes either isolate. */
export const POP_DIRECTIONAL_ISOLATE = String.fromCodePoint(0x20_69);

/** LRI, RLI, FSI and PDI (U+2066 to U+2069). */
const ISOLATE_MARKS = /[\u2066-\u2069]/gu;

/**
 * Only a value written wholly in left-to-right letters needs the isolate.
 * Text holding right-to-left letters was composed for this locale (a nested
 * sentence, an Arabic list of handles) and flows with the sentence, and bare
 * digits and separators (`15`, `12.50`) are laid out as numbers.
 */
const LETTER = /\p{L}/u;
const RTL_LETTER =
	/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
/** A placeholder echo (`{app}`) a caller passes on for a later fill. */
const PLACEHOLDER_ECHO = /^\{[^{}]*\}$/u;
/**
 * A bare URL or email. Plain-text surfaces (chat bots, push, email) autolink
 * these, and a linkifier may take a trailing PDI into the link, so they stay
 * unwrapped.
 */
const LINKABLE =
	/^(?:(?:[a-z][\w+.-]*:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/iu;

function isLtrOnly(text: string): boolean {
	return (
		LETTER.test(text) &&
		!RTL_LETTER.test(text) &&
		!PLACEHOLDER_ECHO.test(text) &&
		!LINKABLE.test(text)
	);
}

/** Sigils that belong to the value after them: `@{handle}`, `#{channel}`. */
const VALUE_SIGILS = new Set(["@", "#"]);

const DIRECTION_CACHE_LIMIT = 32;
const RTL_LOCALES = new Map<string, boolean>();

function isRtl(locale: string): boolean {
	const cached = RTL_LOCALES.get(locale);
	if (cached !== undefined) {
		return cached;
	}
	if (RTL_LOCALES.size >= DIRECTION_CACHE_LIMIT) {
		RTL_LOCALES.clear();
	}
	const rtl = directionForLocale(locale) === "rtl";
	RTL_LOCALES.set(locale, rtl);
	return rtl;
}

function isIsolated(text: string): boolean {
	return (
		(text.startsWith(FIRST_STRONG_ISOLATE) ||
			text.startsWith(LEFT_TO_RIGHT_ISOLATE)) &&
		text.endsWith(POP_DIRECTIONAL_ISOLATE)
	);
}

/**
 * `text` wrapped in FSI ... PDI when `locale` is written right to left;
 * otherwise (and for empty or already isolated text) unchanged.
 */
export function isolateArg(text: string, locale: string): string {
	if (!(text && isRtl(locale)) || isIsolated(text)) {
		return text;
	}
	return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/**
 * `text` wrapped in LRI ... PDI: content that is always left to right (a
 * path, a command, a converter's raw message) shown inside any sentence.
 */
export function isolateLtr(text: string): string {
	if (!text || isIsolated(text)) {
		return text;
	}
	return `${LEFT_TO_RIGHT_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/** `text` without the isolate marks this module adds (for matching or keys). */
export function stripBidiIsolates(text: string): string {
	return text.replace(ISOLATE_MARKS, "");
}

/**
 * Append a simple `{name}` argument to `output` for `locale`. Only string
 * values written wholly in left-to-right letters are isolated: numbers,
 * dates, plural/select output, right-to-left text and placeholder echoes
 * stay as they are. A message that is the argument alone
 * (`whole`) stays unwrapped, since nothing surrounds it. A `@` or `#` written just
 * before the placeholder moves inside the isolate so it stays with the value.
 */
export function appendArgument(
	output: string,
	text: string,
	isString: boolean,
	whole: boolean,
	locale: string
): string {
	if (
		!(isString && text && isRtl(locale)) ||
		whole ||
		isIsolated(text) ||
		!isLtrOnly(text)
	) {
		return output + text;
	}
	const sigil = output.at(-1);
	if (sigil !== undefined && VALUE_SIGILS.has(sigil)) {
		return output.slice(0, -1) + isolateArg(sigil + text, locale);
	}
	return output + isolateArg(text, locale);
}
