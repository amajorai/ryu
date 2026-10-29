import { EN_MESSAGES } from "./en-messages.ts";
import { literalMessageId } from "./message-id.ts";
import { MAX_MESSAGE_LENGTH } from "./pack.ts";

// Literal ids and the registered literal-catalog loader. Catalog-free: the
// catalogs themselves arrive only through a loader that a host registers by
// importing `@ryu/i18n/official-catalog` (or one of its subsets).

let canonicalLiteralIds: Map<string, string> | null = null;

/** Collapse runs of whitespace (including NBSP and newlines) and trim, the
 * same folding JSX applies to text and `tools/i18n-extract.mjs` applies to
 * catalog keys. Case and punctuation are kept: they are part of the copy. */
export function collapseLiteralWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Exact (whitespace-collapsed) English source → canonical id, built once on
 * first lookup. The first id for a duplicated English message wins. */
function canonicalLiteralIndex(): Map<string, string> {
	if (canonicalLiteralIds === null) {
		canonicalLiteralIds = new Map();
		for (const [id, message] of Object.entries(EN_MESSAGES)) {
			const collapsed = collapseLiteralWhitespace(message);
			if (!canonicalLiteralIds.has(collapsed)) {
				canonicalLiteralIds.set(collapsed, id);
			}
		}
	}
	return canonicalLiteralIds;
}

/** Whether `id` is a hashed literal id rather than a named catalog id. */
export function isLiteralMessageId(id: string): boolean {
	return id.startsWith("literal.");
}

/** Prefer the canonical catalog id when the text is exactly a catalog
 * message, then fall back to a stable literal id so shared primitives can
 * localize legacy copy incrementally. Only whitespace is folded: "Loading",
 * "Loading…" and "loading" keep distinct ids, so a translation never changes
 * the case or drops the punctuation of the copy it replaces. */
export function messageIdForLiteral(value: string): string {
	const collapsed = collapseLiteralWhitespace(value);
	return canonicalLiteralIndex().get(collapsed) ?? literalMessageId(collapsed);
}

/**
 * English source literal → translation for one locale. The official catalogs
 * in `packages/i18n/locales/` use this shape, keyed by the strings
 * `tools/i18n-extract.mjs` collects.
 */
export type LiteralCatalog = Readonly<Record<string, string>>;

/**
 * Load the literal catalog for a canonical locale, or null when none ships. A
 * statically bundled catalog may answer synchronously, so the first lookup in
 * that locale is already translated.
 */
export type LiteralCatalogLoader = (
	locale: string
) => LiteralCatalog | null | Promise<LiteralCatalog | null>;

let registeredLoader: LiteralCatalogLoader | null = null;

/**
 * Register the loader every runtime uses for literal catalogs. Host surfaces
 * opt in by importing `@ryu/i18n/official-catalog`; bundles that never import
 * it (Companion apps, which translate through the host) carry no catalog.
 */
export function registerLiteralCatalogLoader(
	loader: LiteralCatalogLoader | null
): void {
	registeredLoader = loader;
}

/** The loader registered by the host surface, if any. */
export function literalCatalogLoader(): LiteralCatalogLoader | null {
	return registeredLoader;
}

/** Literal id → message for one locale, keyed like the DOM localizer's lookups. */
export function indexLiteralCatalog(
	catalog: LiteralCatalog
): Map<string, string> {
	const entries = new Map<string, string>();
	for (const [source, message] of Object.entries(catalog)) {
		if (
			typeof message === "string" &&
			source.trim() &&
			message.trim() &&
			message.length <= MAX_MESSAGE_LENGTH
		) {
			entries.set(messageIdForLiteral(source), message);
		}
	}
	return entries;
}
