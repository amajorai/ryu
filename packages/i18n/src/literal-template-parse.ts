import { placeholderNames } from "./icu-syntax.ts";

// Parsing, compiling and fit checks for literal-catalog templates; the index
// that looks them up is `literal-templates.ts`.

/** One `{name}` argument, the only argument shape a template may use. */
const SIMPLE_ARGUMENT = /^\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}/u;
/** Rich-text tags (`<b>`, `</count>`) never reach DOM text as written. */
const RICH_TAG = /<\/?[A-Za-z][\w-]*\s*\/?>/u;
const LETTER = /[A-Za-zÀ-￿]/gu;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/gu;

/** Fewest letters a template must carry outside its placeholders. */
export const MIN_TEMPLATE_LETTERS = 3;
/** Captured prose words allowed per literal word, so a short template
 * (`Open {name}`) does not rewrite one word of arbitrary user prose. */
const CAPTURED_WORDS_PER_LITERAL_WORD = 2;
/** Captured prose words always allowed (`Deleted Q3 plan`). */
const MIN_CAPTURED_WORDS = 2;

export interface ParsedTemplate {
	/** Literal text around the arguments; one longer than `names`. */
	literals: string[];
	names: string[];
}

/** A catalog template, compiled the first time a lookup tests it. */
export interface Template {
	/** Undefined until first tested; null when the entry is unusable. */
	compiled?: CompiledTemplate | null;
	order: number;
	parsed?: ParsedTemplate | null | undefined;
	/** Whitespace-collapsed English source. */
	source: string;
	translation: string;
}

export interface CompiledTemplate extends ParsedTemplate {
	/** Literal words with a letter; bounds how many words captures may hold. */
	literalWords: number;
	pattern: RegExp;
	/** Literal characters; the longest matching template wins. */
	specificity: number;
}

/** A lowercase dictionary-like word, as running prose is made of; names,
 * titles, numbers, paths and codes (`Q3`, `report.pdf`) are not. */
const PROSE_WORD = /^[a-zß-ÿ]{2,}[.,;:!?]?$/u;

/** Whitespace-separated words carrying at least one letter. */
function letterWords(text: string): number {
	let count = 0;
	for (const word of text.split(" ")) {
		if (/[A-Za-zÀ-￿]/u.test(word)) {
			count += 1;
		}
	}
	return count;
}

function proseWords(text: string): number {
	let count = 0;
	for (const word of text.split(" ")) {
		if (PROSE_WORD.test(word)) {
			count += 1;
		}
	}
	return count;
}

/** A prose word that may start a sentence (`Writes`), for templates with a
 * single substantive literal word, whose captures are the most likely to be prose. */
const ANY_CASE_PROSE_WORD = /^(?:[A-ZÀ-Þ][a-zß-ÿ]+|[a-zß-ÿ]{2,})[.,;:!?]?$/u;
/** Articles too short for {@link PROSE_WORD}; prose inside a longer capture. */
const ARTICLE = /^(?:a|A)$/u;
/** Function words that join two phrases. A capture that starts or ends with
 * one (`and Proofreading` against `Editing {title}`) split a phrase, not a
 * value, and a template made of little more than one (`{a} and {b}`,
 * `Ryu for {role}`) would half-translate any English phrase around it. */
const CONNECTOR = new Set([
	"and",
	"et",
	"for",
	"of",
	"oder",
	"or",
	"ou",
	"to",
	"und",
]);
/** Lowercase determiners that open a noun phrase (`the overview`, `a pull
 * request`) rather than a name, which carries its own capital or code. */
const DETERMINER = new Set([
	"a",
	"an",
	"her",
	"his",
	"its",
	"my",
	"our",
	"that",
	"the",
	"their",
	"these",
	"this",
	"those",
	"your",
]);
/** Lowercase pronouns and determiners that are never a value on their own
 * (`Needs you`, `Waiting on them`): the text is prose that starts like the
 * template. */
const FUNCTION_WORD = new Set([
	// `a` alone is a value as often as an article (`Renamed a to a`).
	...[...DETERMINER].filter((word) => word !== "a"),
	"he",
	"him",
	"it",
	"me",
	"she",
	"them",
	"they",
	"us",
	"we",
	"you",
]);
/** Connectors that make an adjacent capture a phrase rather than a value;
 * `to` is left out so `Back to {page}` keeps matching names. */
const JOINING_CONNECTOR = new Set([...CONNECTOR].filter((w) => w !== "to"));
/** Share of the text that captures spanning several words, at least half
 * of them prose, may hold; past it the text is a sentence that only starts like the
 * template (`Can I keep each client's data separated?`). */
const MAX_PROSE_CAPTURE_SHARE = 0.7;
const DIGIT = /\d/u;
/** A separator between two phrases (`Ada: Release`, `notes · 0:03`). A
 * template with one substantive word that captures one matched the edge of
 * a composed label, not a value. */
const CLAUSE_BREAK = /[;:](?:\s|$)|\s[·|—–]\s/u;
/** A comma that separates phrases rather than grouping digits (`1,234`). */
const LIST_COMMA = /(?<!\d),|,(?!\d)/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/** Whether a capture mixes Latin and non-Latin letters (`notes を開く`
 * against `Release {version}`): the template matched the English half of
 * text that is already translated. A value wholly in one script (`田中`,
 * `Q3 plan`) fits. */
function mixesScripts(value: string): boolean {
	return LATIN_LETTER.test(value) && NON_LATIN_LETTER.test(value);
}

function bareWord(word: string): string {
	return word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
}

function captureWords(value: string): string[] {
	return value.split(" ").filter((word) => word.length > 0);
}

/** Literal words that carry meaning: lettered words other than connectors. */
function substantiveLiteralWords(compiled: CompiledTemplate): number {
	let count = 0;
	for (const word of compiled.literals.join(" ").split(" ")) {
		if (/[A-Za-zÀ-￿]/u.test(word) && !CONNECTOR.has(bareWord(word))) {
			count += 1;
		}
	}
	return count;
}

/** Fewest words in a capture that is prose when every word is lowercase
 * (`write the first review.`), whatever the template. */
const MIN_PROSE_RUN = 3;

/** Whether a capture opens or closes on a connector word, opens on a
 * lowercase determiner or closes on one (`Couldn't copy the`), is a lone
 * lowercase pronoun or determiner (`you`), or is a run
 * of {@link MIN_PROSE_RUN} or more lowercase prose words. */
function edgeConnector(value: string): boolean {
	const words = captureWords(value);
	const first = words[0];
	const last = words.at(-1);
	return (
		(first !== undefined &&
			(CONNECTOR.has(bareWord(first)) ||
				(words.length > 1 && DETERMINER.has(first)) ||
				(words.length === 1 && FUNCTION_WORD.has(first)))) ||
		(last !== undefined &&
			(CONNECTOR.has(bareWord(last)) ||
				(words.length > 1 && DETERMINER.has(last)))) ||
		(words.length >= MIN_PROSE_RUN &&
			words.every((word) => ARTICLE.test(word) || PROSE_WORD.test(word)))
	);
}

/** Whether a capture holding a list comma has an item that is not a value
 * (`you, 2 conversations` against `Needs {engine}`): the template matched
 * the start of a longer list or clause. A list of values (`en, ja`) fits. */
function listSplitsPhrase(value: string): boolean {
	const items = value.split(LIST_COMMA);
	return (
		items.length > 1 &&
		items.some((item) => {
			const trimmed = item.trim();
			return trimmed.length > 0 && edgeConnector(trimmed);
		})
	);
}

/** Whether a capture without a digit sits beside a literal connector. */
function besideConnector(
	compiled: CompiledTemplate,
	values: Record<string, string>
): boolean {
	return compiled.names.some((name, index) => {
		if (DIGIT.test(values[name] ?? "")) {
			return false;
		}
		const before = (compiled.literals[index] ?? "").trimEnd().split(" ").at(-1);
		const after = (compiled.literals[index + 1] ?? "")
			.trimStart()
			.split(" ")[0];
		return [before, after].some(
			(word) => word !== undefined && JOINING_CONNECTOR.has(bareWord(word))
		);
	});
}

/** Whether multi-word prose captures fill most of the matched text. */
function proseFillsText(
	compiled: CompiledTemplate,
	values: Record<string, string>
): boolean {
	let captured = 0;
	let prose = false;
	for (const name of compiled.names) {
		const value = values[name] ?? "";
		captured += value.length;
		const words = captureWords(value);
		const proseCount = words.filter((word) => PROSE_WORD.test(word)).length;
		if (words.length > 1 && proseCount * 2 >= words.length) {
			prose = true;
		}
	}
	const total = captured + compiled.literals.join("").length;
	return prose && total > 0 && captured / total > MAX_PROSE_CAPTURE_SHARE;
}

/** The single-substantive-word check: no all-prose capture, at most
 * {@link MIN_CAPTURED_WORDS} prose words. */
function fitsShortTemplate(
	compiled: CompiledTemplate,
	captured: string
): boolean {
	const words = captureWords(captured);
	// A capture opening the text is capitalized as a sentence's first word
	// (`Release notes` against `{count} notes`), not as a name.
	const opensText = compiled.literals[0] === "";
	const asProse = (word: string, index: number) =>
		(words.length > 1 && ARTICLE.test(word)) ||
		PROSE_WORD.test(
			opensText && index === 0
				? `${word.charAt(0).toLowerCase()}${word.slice(1)}`
				: word
		);
	if (words.length > 0 && words.every(asProse)) {
		return false;
	}
	const prose = words.filter((word) => ANY_CASE_PROSE_WORD.test(word));
	return prose.length <= MIN_CAPTURED_WORDS;
}

/**
 * Whether captured values are short enough relative to the template's own
 * words to be values, rather than prose that merely starts like it. Only
 * template matching of dynamic text (DOM text, host relays) runs this;
 * explicit `tl()` calls format their own values.
 *
 * A capture never opens or closes on a connector (`and Proofreading`),
 * opens on a lowercase determiner (`the overview`), lists an item that
 * is not a value (`you, 2 conversations`) or mixes Latin and non-Latin
 * letters (`notes を開く`). A
 * template with at most one substantive literal word (`Release {version}`,
 * `{count} notes`, `Ryu for {role}`, `{a} and {b}`) is stricter: no capture
 * holds a phrase separator (`Ada: Release`), a capture
 * without a digit may not sit beside a joining connector, its captures may
 * hold at most {@link MIN_CAPTURED_WORDS} prose words even when capitalized
 * (`Writes the release notes` is a sentence), and a capture of nothing but
 * lowercase words is prose, not a value (`Release notes`, `Review a pull
 * request`), since values carry a name, number, path or code. Multi-word
 * prose captures may not fill more than {@link MAX_PROSE_CAPTURE_SHARE} of
 * the text.
 */
export function capturesFitTemplate(
	compiled: CompiledTemplate,
	values: Record<string, string>
): boolean {
	if (
		Object.values(values).some(
			(value) =>
				mixesScripts(value) || edgeConnector(value) || listSplitsPhrase(value)
		) ||
		proseFillsText(compiled, values)
	) {
		return false;
	}
	const captured = Object.values(values).join(" ");
	if (substantiveLiteralWords(compiled) <= 1) {
		return (
			!(CLAUSE_BREAK.test(captured) || besideConnector(compiled, values)) &&
			fitsShortTemplate(compiled, captured)
		);
	}
	return (
		proseWords(captured) <=
		Math.max(
			MIN_CAPTURED_WORDS,
			CAPTURED_WORDS_PER_LITERAL_WORD * compiled.literalWords
		)
	);
}

/**
 * Split a whitespace-collapsed English source into literals and simple
 * arguments, or null when it is not a usable template: no argument, a
 * plural/select/other complex argument, a stray brace, rich-text tags, two
 * adjacent arguments (ambiguous), or fewer than {@link MIN_TEMPLATE_LETTERS}
 * literal letters.
 */
export function parseLiteralTemplate(source: string): ParsedTemplate | null {
	if (RICH_TAG.test(source)) {
		return null;
	}
	const literals: string[] = [];
	const names: string[] = [];
	let literal = "";
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("{", cursor);
		const close = source.indexOf("}", cursor);
		if (close >= 0 && (open < 0 || close < open)) {
			return null;
		}
		if (open < 0) {
			literal += source.slice(cursor);
			break;
		}
		literal += source.slice(cursor, open);
		const argument = SIMPLE_ARGUMENT.exec(source.slice(open));
		if (!argument?.[1] || (names.length > 0 && literal === "")) {
			return null;
		}
		literals.push(literal);
		names.push(argument[1]);
		literal = "";
		cursor = open + argument[0].length;
	}
	literals.push(literal);
	const letters = literals.join("").match(LETTER)?.length ?? 0;
	return names.length > 0 && letters >= MIN_TEMPLATE_LETTERS
		? { literals, names }
		: null;
}

function compilePattern(template: ParsedTemplate): RegExp {
	const seen = new Map<string, number>();
	let pattern = "^";
	template.literals.forEach((literal, index) => {
		pattern += literal.replace(REGEX_SPECIAL, "\\$&");
		const name = template.names[index];
		if (name === undefined) {
			return;
		}
		const group = seen.get(name);
		if (group === undefined) {
			seen.set(name, seen.size + 1);
			pattern += "(.+?)";
		} else {
			// A repeated argument must repeat the same value.
			pattern += `\\${group}`;
		}
	});
	return new RegExp(`${pattern}$`, "u");
}

/** Parse, check the translation's arguments and compile one template. */
export function compileTemplate(template: Template): CompiledTemplate | null {
	const parsed =
		template.parsed === undefined
			? parseLiteralTemplate(template.source)
			: template.parsed;
	if (
		parsed === null ||
		JSON.stringify(placeholderNames(template.translation)) !==
			JSON.stringify([...new Set(parsed.names)].sort())
	) {
		return null;
	}
	return {
		...parsed,
		literalWords: letterWords(parsed.literals.join(" ")),
		pattern: compilePattern(parsed),
		specificity: parsed.literals.join("").length,
	};
}
