// Translate CLI copy against the bundled `cli` subset of the official literal
// catalogs. Keys are the exact English strings `tools/i18n-extract.mjs`
// collects, so only known UI copy changes; data (names, ids, output) never
// matches and stays as-is.

import { formatMessage, type LiteralCatalog } from "@ryu/i18n/core";
import { officialCliLiteralCatalog } from "@ryu/i18n/official-catalog/cli";
import { cliLocale } from "./locale.ts";

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
}

export function createCliTranslator(
	locale: string | null,
	catalog: LiteralCatalog | null
): CliTranslator {
	const resolvedLocale = locale ?? "en";
	const tr = (value: string): string => {
		if (!catalog) {
			return value;
		}
		const source = value.trim();
		const translated = source ? catalog[source] : undefined;
		if (translated === undefined) {
			return value;
		}
		return source === value ? translated : value.replace(source, translated);
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
		tf: (source, values) =>
			formatMessage(catalog?.[source] ?? source, values, resolvedLocale),
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

const locale = cliLocale();
const translator = createCliTranslator(
	locale,
	locale ? officialCliLiteralCatalog(locale) : null
);

/** The locale the CLI renders in (`en` when no official catalog matches). */
export const CLI_LOCALE = translator.locale;
export const { tr, tf, translateProps } = translator;
