import { formatMessage } from "./format.ts";
import { stripBidiIsolates } from "./format-bidi.ts";
import {
	collapseLiteralWhitespace,
	type LiteralCatalog,
} from "./literal-catalog.ts";
import { formatCapturedNumeral } from "./literal-template-numerals.ts";
import {
	type CompiledTemplate,
	capturesFitTemplate,
	compileTemplate,
	parseLiteralTemplate,
	type Template,
} from "./literal-template-parse.ts";
import { MAX_MESSAGE_LENGTH } from "./pack.ts";

export {
	MIN_TEMPLATE_LETTERS,
	parseLiteralTemplate,
} from "./literal-template-parse.ts";

// Template matching for dynamic sentences. When text has no exact catalog
// entry, the literal catalog's ICU templates with only simple arguments
// (`Deleted {name}`, never plural/select) are tried as anchored patterns; a
// match formats the translation with the captured values. Captured values are
// inserted verbatim and never ICU-parsed: they are data. The one exception is
// a relayed reason (`Synthesis failed: {error}`): when the captured value is
// itself catalog copy, an exact entry or (under depth and length caps) another
// template, its translation is inserted, so the reason is not left in English.
// A second, opt-in exception is a label argument named `…Label`
// (`More about {titleLabel}`): its value is a catalog label, so an exact entry
// replaces it. Plain `{title}`/`{name}` values stay verbatim: they may be user
// content, except a plain decimal quantity (`12.50`), which is reformatted for
// the reader's locale (`literal-template-numerals.ts`).

/** Longest text tried against templates; dynamic UI sentences are short,
 * and the cap bounds lazy-capture backtracking. */
export const MAX_TEMPLATE_TEXT_LENGTH = 500;
/** Arguments that relay another message (an error's or a reason's text). */
const RELAY_ARGUMENTS = new Set([
	"cause",
	"detail",
	"error",
	"message",
	"reason",
	"value",
]);
/** Suffix of an argument whose value is a catalog label (`{titleLabel}`). */
const LABEL_ARGUMENT_SUFFIX = "Label";

function isLabelArgument(name: string): boolean {
	return (
		name.length > LABEL_ARGUMENT_SUFFIX.length &&
		name.endsWith(LABEL_ARGUMENT_SUFFIX)
	);
}
/** Nested relay levels translated below the outer sentence. */
export const MAX_RELAY_DEPTH = 2;
/** Longest relayed value looked up; longer text is raw output, not copy. */
export const MAX_RELAY_VALUE_LENGTH = 300;
/** Most texts whose answer an index remembers between lookups. */
const RESULT_CACHE_LIMIT = 512;

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
	/** The whole catalog, kept for exact lookups of relayed values. */
	private readonly entries: LiteralCatalog;
	private size = 0;

	constructor(catalog: LiteralCatalog) {
		this.catalog = catalog;
		this.entries = catalog;
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
		const collapsed = collapseLiteralWhitespace(stripBidiIsolates(text));
		if (!collapsed || collapsed.length > MAX_TEMPLATE_TEXT_LENGTH) {
			return;
		}
		const cacheKey = `${locale}\u0000${collapsed}`;
		const cached = this.results.get(cacheKey);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const output = this.find(collapsed, locale, 0);
		if (this.results.size >= RESULT_CACHE_LIMIT) {
			this.results.clear();
		}
		this.results.set(cacheKey, output);
		return output ?? undefined;
	}

	/**
	 * A relayed value's translation: its exact catalog entry, else a template
	 * match one level deeper, else the value unchanged. Past
	 * {@link MAX_RELAY_DEPTH} or {@link MAX_RELAY_VALUE_LENGTH} it stays as is.
	 */
	private relayed(value: string, locale: string, depth: number): string {
		if (
			depth >= MAX_RELAY_DEPTH ||
			!value ||
			value.length > MAX_RELAY_VALUE_LENGTH
		) {
			return value;
		}
		return (
			this.exactEntry(value) ?? this.find(value, locale, depth + 1) ?? value
		);
	}

	/** The exact catalog translation of a plain (argument-free) value. */
	private exactEntry(value: string): string | undefined {
		const exact = Object.hasOwn(this.entries, value)
			? this.entries[value]
			: undefined;
		return typeof exact === "string" &&
			!value.includes("{") &&
			exact.trim() &&
			exact.length <= MAX_MESSAGE_LENGTH
			? exact
			: undefined;
	}

	/** A `…Label` value's exact catalog entry, else the value unchanged. */
	private labeled(name: string, value: string): string {
		if (
			!(isLabelArgument(name) && value) ||
			value.length > MAX_RELAY_VALUE_LENGTH
		) {
			return value;
		}
		return this.exactEntry(value) ?? value;
	}

	/** The best template's translation of collapsed `text`, or null. */
	private find(
		collapsed: string,
		locale: string,
		depth: number
	): string | null {
		this.build();
		let best: {
			compiled: CompiledTemplate;
			order: number;
			relayed: Record<string, string> | null;
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
			let relayed: Record<string, string> | null = null;
			if (!capturesFitTemplate(compiled, values)) {
				relayed = this.relayedFit(
					compiled,
					values,
					locale,
					depth,
					template.translation
				);
				if (relayed === null) {
					continue;
				}
			}
			best = {
				compiled,
				order: template.order,
				relayed,
				translation: template.translation,
				values,
			};
		}
		if (!best) {
			return null;
		}
		let values = best.relayed;
		if (values === null) {
			values = {};
			for (const [name, value] of Object.entries(best.values)) {
				values[name] = RELAY_ARGUMENTS.has(name)
					? this.relayed(value, locale, depth)
					: this.labeled(
							name,
							formatCapturedNumeral(name, value, locale, best.translation)
						);
			}
		}
		return formatMessage(best.translation, values, locale);
	}

	/**
	 * A relay carries a whole sentence (`Failed: {error}`), more prose than
	 * the capture budget allows. Accept it only when every relayed value is
	 * itself catalog copy and the other values fit; returns the values with
	 * the relays translated, or null.
	 */
	private relayedFit(
		compiled: CompiledTemplate,
		values: Record<string, string>,
		locale: string,
		depth: number,
		translation: string
	): Record<string, string> | null {
		const plain: Record<string, string> = {};
		const output: Record<string, string> = {};
		let relays = 0;
		for (const [name, value] of Object.entries(values)) {
			if (!RELAY_ARGUMENTS.has(name)) {
				plain[name] = value;
				output[name] = this.labeled(
					name,
					formatCapturedNumeral(name, value, locale, translation)
				);
				continue;
			}
			const translated = this.relayed(value, locale, depth);
			if (translated === value) {
				return null;
			}
			output[name] = translated;
			relays += 1;
		}
		return relays > 0 && capturesFitTemplate(compiled, plain) ? output : null;
	}
}
