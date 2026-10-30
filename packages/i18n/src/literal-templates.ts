import { formatMessage } from "./format.ts";
import { placeholderNames } from "./icu-syntax.ts";
import {
	collapseLiteralWhitespace,
	type LiteralCatalog,
} from "./literal-catalog.ts";
import { MAX_MESSAGE_LENGTH } from "./pack.ts";

// Template matching for dynamic sentences. When text has no exact catalog
// entry, the literal catalog's ICU templates with only simple arguments
// (`Deleted {name}`, never plural/select) are tried as anchored patterns; a
// match formats the translation with the captured values. Captured values are
// inserted verbatim: they are data, never re-translated and never ICU-parsed.

/** One `{name}` argument, the only argument shape a template may use. */
const SIMPLE_ARGUMENT = /^\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}/u;
/** Rich-text tags (`<b>`, `</count>`) never reach DOM text as written. */
const RICH_TAG = /<\/?[A-Za-z][\w-]*\s*\/?>/u;
const LETTER = /[A-Za-zÀ-￿]/gu;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/gu;

/** Fewest letters a template must carry outside its placeholders. */
export const MIN_TEMPLATE_LETTERS = 3;
/** Longest text tried against templates; dynamic UI sentences are short,
 * and the cap bounds lazy-capture backtracking. */
export const MAX_TEMPLATE_TEXT_LENGTH = 500;
/** Captured prose words allowed per literal word, so a short template
 * (`Open {name}`) does not rewrite one word of arbitrary user prose. */
const CAPTURED_WORDS_PER_LITERAL_WORD = 2;
/** Captured prose words always allowed (`Deleted Q3 plan`). */
const MIN_CAPTURED_WORDS = 2;
/** Most texts whose answer an index remembers between lookups. */
const RESULT_CACHE_LIMIT = 512;

interface ParsedTemplate {
	/** Literal text around the arguments; one longer than `names`. */
	literals: string[];
	names: string[];
}

/** A catalog template, compiled the first time a lookup tests it. */
interface Template {
	/** Undefined until first tested; null when the entry is unusable. */
	compiled?: CompiledTemplate | null;
	order: number;
	parsed?: ParsedTemplate | null | undefined;
	/** Whitespace-collapsed English source. */
	source: string;
	translation: string;
}

interface CompiledTemplate extends ParsedTemplate {
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

/** Whether captured values are short enough relative to the template's own
 * words to be values, rather than prose that merely starts like it. */
function capturesFitTemplate(
	compiled: CompiledTemplate,
	values: Record<string, string>
): boolean {
	const captured = proseWords(Object.values(values).join(" "));
	return (
		captured <=
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
function compileTemplate(template: Template): CompiledTemplate | null {
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

/** Templates sharing one leading literal, keyed by their trailing literal. */
interface HeadBucket {
	tailLengths: number[];
	tails: Map<string, Template[]>;
}

/** The longest space-bounded word inside a middle literal, if any. */
function middleWord(literals: readonly string[]): string | null {
	let best: string | null = null;
	for (const literal of literals.slice(1, -1)) {
		for (const word of literal.split(" ").slice(1, -1)) {
			if (word && (best === null || word.length > best.length)) {
				best = word;
			}
		}
	}
	return best;
}

function sortedLengths(keys: Iterable<string>): number[] {
	return [...new Set([...keys].map((key) => key.length))].sort((a, b) => a - b);
}

/**
 * The simple-argument templates of one literal catalog, built on the first
 * lookup. Every matching text starts with a template's leading literal and
 * ends with its trailing literal, so templates are bucketed by both: a lookup
 * probes the text's prefixes and suffixes of the lengths the index holds and
 * tests only the few patterns found there. A template that is all arguments
 * at both ends (`{shown} out of {total}`) is keyed by a whole word of its
 * middle literal instead.
 */
export class LiteralTemplateIndex {
	private built = false;
	private readonly heads = new Map<string, HeadBucket>();
	private headLengths: number[] = [];
	private readonly words = new Map<string, Template[]>();
	private readonly unindexed: Template[] = [];
	private readonly results = new Map<string, string | null>();
	private catalog: LiteralCatalog | null;
	private size = 0;

	constructor(catalog: LiteralCatalog) {
		this.catalog = catalog;
	}

	/** Number of indexed candidate templates (builds the index). */
	get templateCount(): number {
		this.build();
		return this.size;
	}

	private add(template: Template): boolean {
		const { source } = template;
		const head = source.slice(0, source.indexOf("{"));
		const tail = source.slice(source.lastIndexOf("}") + 1);
		if (!(head || tail)) {
			// Only arguments at both ends: key by a middle word, parsed now.
			template.parsed = parseLiteralTemplate(source);
			if (template.parsed === null) {
				return false;
			}
			const word = middleWord(template.parsed.literals);
			if (word === null) {
				this.unindexed.push(template);
				return true;
			}
			const bucket = this.words.get(word);
			if (bucket) {
				bucket.push(template);
			} else {
				this.words.set(word, [template]);
			}
			return true;
		}
		let headBucket = this.heads.get(head);
		if (!headBucket) {
			headBucket = { tailLengths: [], tails: new Map() };
			this.heads.set(head, headBucket);
		}
		const bucket = headBucket.tails.get(tail);
		if (bucket) {
			bucket.push(template);
		} else {
			headBucket.tails.set(tail, [template]);
		}
		return true;
	}

	/** Bucket every entry with an argument; parsing and checks wait for a
	 * lookup to test the entry, so building stays a single cheap pass. */
	private build(): void {
		if (this.built) {
			return;
		}
		this.built = true;
		const catalog = this.catalog ?? {};
		this.catalog = null;
		for (const [rawSource, translation] of Object.entries(catalog)) {
			if (
				typeof translation === "string" &&
				rawSource.includes("{") &&
				translation.trim() &&
				translation.length <= MAX_MESSAGE_LENGTH &&
				this.add({
					order: this.size,
					source: collapseLiteralWhitespace(rawSource),
					translation,
				})
			) {
				this.size += 1;
			}
		}
		for (const bucket of this.heads.values()) {
			bucket.tailLengths = sortedLengths(bucket.tails.keys());
		}
		this.headLengths = sortedLengths(this.heads.keys());
	}

	private candidates(text: string): Template[] {
		const found: Template[] = [];
		for (const headLength of this.headLengths) {
			if (headLength >= text.length) {
				break;
			}
			const headBucket = this.heads.get(text.slice(0, headLength));
			if (!headBucket) {
				continue;
			}
			const room = text.length - headLength;
			for (const tailLength of headBucket.tailLengths) {
				if (tailLength >= room) {
					break;
				}
				const bucket = headBucket.tails.get(
					text.slice(text.length - tailLength)
				);
				if (bucket) {
					found.push(...bucket);
				}
			}
		}
		if (this.words.size > 0) {
			for (const word of new Set(text.split(" "))) {
				const bucket = this.words.get(word);
				if (bucket) {
					found.push(...bucket);
				}
			}
		}
		found.push(...this.unindexed);
		return found;
	}

	/**
	 * The translation of `text` through the most specific matching template,
	 * formatted for `locale`, or undefined when no template matches.
	 */
	match(text: string, locale: string): string | undefined {
		const collapsed = collapseLiteralWhitespace(text);
		if (!collapsed || collapsed.length > MAX_TEMPLATE_TEXT_LENGTH) {
			return;
		}
		const cacheKey = `${locale}\u0000${collapsed}`;
		const cached = this.results.get(cacheKey);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		this.build();
		let best: {
			compiled: CompiledTemplate;
			order: number;
			translation: string;
			values: Record<string, string>;
		} | null = null;
		for (const template of this.candidates(collapsed)) {
			if (template.compiled === undefined) {
				template.compiled = compileTemplate(template);
				template.parsed = undefined;
			}
			const { compiled } = template;
			if (
				compiled === null ||
				(best &&
					(compiled.specificity < best.compiled.specificity ||
						(compiled.specificity === best.compiled.specificity &&
							template.order > best.order)))
			) {
				continue;
			}
			const captured = compiled.pattern.exec(collapsed);
			if (!captured) {
				continue;
			}
			const values: Record<string, string> = {};
			let group = 1;
			for (const name of compiled.names) {
				if (!Object.hasOwn(values, name)) {
					values[name] = captured[group] ?? "";
					group += 1;
				}
			}
			if (!capturesFitTemplate(compiled, values)) {
				continue;
			}
			best = {
				compiled,
				order: template.order,
				translation: template.translation,
				values,
			};
		}
		const output = best
			? formatMessage(best.translation, best.values, locale)
			: null;
		if (this.results.size >= RESULT_CACHE_LIMIT) {
			this.results.clear();
		}
		this.results.set(cacheKey, output);
		return output ?? undefined;
	}
}
