// Translate CLI copy against the bundled `cli` subset of the official literal
// catalogs. Keys are the exact English strings `tools/i18n-extract.mjs`
// collects, so only known UI copy changes; data (names, ids, output) never
// matches and stays as-is. A thrown message carries its values inline
// (`Invalid duration '5x'.`), so `trMessage` also matches it against the
// catalog's ICU templates and fills the translation with the captured values.

import { formatMessage, type LiteralCatalog } from "@ryu/i18n/core";
import { LiteralTemplateIndex } from "@ryu/i18n/literal-templates";
import { officialCliLiteralCatalog } from "@ryu/i18n/official-catalog/cli";
import { cliLocales } from "./locale.ts";

/** Props whose string values are rendered as copy, mirroring the extractor. */
const TEXT_PROP =
	/^(?:alt|caption|cta|description|emptyText|errorMessage|heading|helperText|hint|label|loadingText|message|placeholder|subtitle|summary|tagline|title|tooltip|[a-z]+(?:Label|Text|Title|Description|Placeholder|Message|Heading|Hint|Tooltip|Caption))$/u;

export interface CliTranslator {
	locale: string;
	/** Translate an ICU message (`"{count} files"`) and fill its placeholders. */
	tf(source: string, values: Readonly<Record<string, string | number>>): string;
	/** Translate a literal, keeping the surrounding whitespace JSX left on it. */
	tr(value: string): string;
	/** Translate string children and copy props before an element is created. */
	translateProps<Props>(props: Props): Props;
	/**
	 * Translate a finished sentence such as an error message: an exact catalog
	 * entry, else the catalog template it matches (`Invalid duration '{value}'.`)
	 * with the captured values filled in, else the text unchanged.
	 */
	trMessage(value: string): string;
}

/** Keys are whitespace-collapsed, so aligned copy (`Reliable   {rate}%`)
 * still finds its entry. */
function lookup(catalog: LiteralCatalog, source: string): string | undefined {
	if (!source) {
		return;
	}
	if (Object.hasOwn(catalog, source)) {
		return catalog[source];
	}
	const collapsed = source.replace(/\s+/gu, " ");
	return Object.hasOwn(catalog, collapsed) ? catalog[collapsed] : undefined;
}

export function createCliTranslator(
	locale: string | null,
	catalog: LiteralCatalog | null
): CliTranslator {
	const resolvedLocale = locale ?? "en";
	let templates: LiteralTemplateIndex | null = null;
	const tr = (value: string): string => {
		if (!catalog) {
			return value;
		}
		const source = value.trim();
		const translated = lookup(catalog, source);
		if (translated === undefined) {
			return value;
		}
		return source === value ? translated : value.replace(source, translated);
	};
	const trMessage = (value: string): string => {
		if (!catalog) {
			return value;
		}
		const source = value.trim();
		if (lookup(catalog, source) !== undefined) {
			return tr(value);
		}
		templates ??= new LiteralTemplateIndex(catalog);
		return (source && templates.match(source, resolvedLocale)) || value;
	};
	const translateChild = (child: unknown): unknown => {
		if (typeof child === "string") {
			return tr(child);
		}
		if (Array.isArray(child)) {
			return child.map(translateChild);
		}
		return child;
	};
	return {
		locale: resolvedLocale,
		tr,
		trMessage,
		tf: (source, values) =>
			formatMessage(
				(catalog && lookup(catalog, source)) ?? source,
				values,
				resolvedLocale
			),
		translateProps<Props>(props: Props): Props {
			if (!catalog || props === null || typeof props !== "object") {
				return props;
			}
			const entries = Object.entries(props);
			let next: Record<string, unknown> | null = null;
			for (const [name, value] of entries) {
				let translated: unknown = value;
				if (name === "children") {
					translated = translateChild(value);
				} else if (typeof value === "string" && TEXT_PROP.test(name)) {
					translated = tr(value);
				}
				if (translated !== value) {
					next ??= Object.fromEntries(entries);
					next[name] = translated;
				}
			}
			// SAFETY: `next` is a shallow copy of `props` with only string values replaced.
			return (next as Props | null) ?? props;
		},
	};
}

const locales = cliLocales();
const translator = createCliTranslator(
	locales.messages,
	locales.messages ? officialCliLiteralCatalog(locales.messages) : null
);

/** The locale the CLI renders copy in (`en` when no official catalog matches). */
export const CLI_LOCALE = translator.locale;
/** The locale the CLI formats dates and numbers in (`de-AT`, `en-GB`, `sv-SE`). */
export const CLI_FORMAT_LOCALE = locales.format;
/** The process-wide translator, for callers that take one as a parameter. */
export const CLI_TRANSLATOR: CliTranslator = translator;
export const { tr, tf, trMessage, translateProps } = translator;
