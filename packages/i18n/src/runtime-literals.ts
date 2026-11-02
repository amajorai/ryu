import { officialCatalogLocale } from "./catalog-locale.ts";
import {
	indexLiteralCatalog,
	type LiteralCatalogLoader,
	literalCatalogLoader,
	messageIdForLiteral,
} from "./literal-catalog.ts";
import { LiteralTemplateIndex } from "./literal-templates.ts";
import { canonicalLocale, localeLanguageAndScript } from "./locale.ts";
import { DEFAULT_LOCALE, MAX_MESSAGE_LENGTH } from "./pack.ts";

/**
 * App-owned message catalogs layered under the selected language pack:
 * locale (such as `es` or `pt-BR`) → English source literal → translation.
 * A Companion app ships these for its own copy; they never shadow a pack's
 * message and are keyed by the same literal ids the DOM localizer uses.
 */
export type MessageOverlays = Readonly<
	Record<string, Readonly<Record<string, string>>>
>;

/**
 * A runtime's app overlays and official literal catalogs, keyed by language
 * and script. Catalogs load on the first lookup in a locale; `onLoaded` hears
 * the key of a catalog that arrived asynchronously, so the runtime can
 * publish when it is the one being shown.
 */
export class RuntimeLiteralCatalogs {
	/** Overlay messages by language-and-script key, then message id. */
	private overlays = new Map<string, Map<string, string>>();
	/** Official literal catalogs by language-and-script key; null while loading. */
	private readonly catalogs = new Map<string, Map<string, string> | null>();
	/** Simple-argument templates of each loaded literal catalog, built lazily. */
	private readonly templates = new Map<string, LiteralTemplateIndex>();
	private readonly onLoaded: (key: string) => void;

	constructor(onLoaded: (key: string) => void) {
		this.onLoaded = onLoaded;
	}

	setOverlays(overlays: MessageOverlays): void {
		const next = new Map<string, Map<string, string>>();
		for (const [locale, messages] of Object.entries(overlays)) {
			const key = localeLanguageAndScript(canonicalLocale(locale, locale));
			const entries = next.get(key) ?? new Map<string, string>();
			for (const [source, message] of Object.entries(messages)) {
				if (
					source.trim() &&
					message.trim() &&
					message.length <= MAX_MESSAGE_LENGTH
				) {
					entries.set(messageIdForLiteral(source), message);
				}
			}
			next.set(key, entries);
		}
		this.overlays = next;
	}

	/**
	 * Whether these catalogs can show `locale` without a language pack: an
	 * app overlay for it, or an official literal catalog a loader serves.
	 */
	serves(locale: string): boolean {
		return (
			this.overlays.has(localeLanguageAndScript(locale)) ||
			(literalCatalogLoader() !== null &&
				officialCatalogLocale(locale) !== null)
		);
	}

	/** The overlay message for `id` in `locale`, then the literal catalog's. */
	overlayMessage(locale: string, id: string): string | undefined {
		const key = localeLanguageAndScript(locale);
		return (
			this.overlays.get(key)?.get(id) ??
			this.literalCatalogMessage(locale, key, id)
		);
	}

	/** `text` through the literal catalog's templates, if one matches. */
	templateMessage(locale: string, text: string): string | undefined {
		const loader = literalCatalogLoader();
		if (loader === null || locale === DEFAULT_LOCALE) {
			return;
		}
		const key = localeLanguageAndScript(locale);
		if (!this.catalogs.has(key)) {
			this.load(locale, key, loader);
		}
		return this.templates.get(key)?.match(text, locale);
	}

	private literalCatalogMessage(
		locale: string,
		key: string,
		id: string
	): string | undefined {
		const loader = literalCatalogLoader();
		if (loader === null || locale === DEFAULT_LOCALE) {
			return;
		}
		const catalog = this.catalogs.get(key);
		if (catalog === undefined) {
			return this.load(locale, key, loader)?.get(id);
		}
		return catalog?.get(id);
	}

	/** Index the catalog for `key`; returns it when the loader answered synchronously. */
	private load(
		locale: string,
		key: string,
		loader: LiteralCatalogLoader
	): Map<string, string> | null {
		let result: ReturnType<LiteralCatalogLoader>;
		try {
			result = loader(locale);
		} catch {
			result = null;
		}
		if (!(result instanceof Promise)) {
			const catalog = indexLiteralCatalog(result ?? {});
			this.catalogs.set(key, catalog);
			this.templates.set(key, new LiteralTemplateIndex(result ?? {}));
			return catalog;
		}
		this.catalogs.set(key, null);
		result
			.then((catalog) => {
				this.catalogs.set(key, indexLiteralCatalog(catalog ?? {}));
				this.templates.set(key, new LiteralTemplateIndex(catalog ?? {}));
				if (catalog) {
					this.onLoaded(key);
				}
			})
			.catch(() => {
				// A missing chunk leaves the locale on its pack and English fallback;
				// keep the empty entry so lookups do not retry on every render.
				this.catalogs.set(key, new Map());
			});
		return null;
	}
}
