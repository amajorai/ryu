import { officialCatalogLocale } from "./catalog-locale.ts";
import { formatMessage } from "./format.ts";
import {
	indexLiteralCatalog,
	isLiteralMessageId,
	type LiteralCatalog,
	messageIdForLiteral,
} from "./literal-catalog.ts";
import { LiteralTemplateIndex } from "./literal-templates.ts";
import { MAX_MESSAGE_LENGTH, placeholderNames } from "./pack.ts";
import type { I18nHostSnapshot } from "./runtime.ts";

// Per-app official catalogs for Companion frames on hosts that bundle only
// their own subset (the mobile app). `tools/i18n-catalog.mjs build` writes
// `packages/i18n/locales/apps/<slug>/<locale>.json` for every `@ryu/<slug>`
// app; a host fetches the opened app's file and answers the frame's
// `i18n.translate` calls from it after its own catalog.

/**
 * Where the published per-app catalogs are served: the public mirror's raw
 * files (jsDelivr's `/gh/` endpoint refuses repositories over its package
 * size limit, which the mirror exceeds).
 */
export const OFFICIAL_APP_CATALOG_BASE_URL =
	"https://raw.githubusercontent.com/amajorai/ryu/main/packages/i18n/locales/apps";

/** Largest app catalog accepted, in characters of JSON. */
export const MAX_APP_CATALOG_LENGTH = 4_000_000;

const OFFICIAL_APP_ID = /^@ryu\/([a-z0-9][a-z0-9-]*)$/u;

/** The catalog slug of an official `@ryu/<slug>` app, or null for others. */
export function officialAppCatalogSlug(pluginId: string): string | null {
	return OFFICIAL_APP_ID.exec(pluginId)?.[1] ?? null;
}

/** Which file serves `pluginId` in `locale`, or null when none can. */
export function officialAppCatalogKey(
	pluginId: string,
	locale: string
): { locale: string; slug: string } | null {
	const slug = officialAppCatalogSlug(pluginId);
	const official = officialCatalogLocale(locale);
	return slug && official ? { locale: official, slug } : null;
}

/** The published URL of an app catalog. */
export function officialAppCatalogUrl(
	key: { locale: string; slug: string },
	baseUrl: string = OFFICIAL_APP_CATALOG_BASE_URL
): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${key.slug}/${key.locale}.json`;
}

/**
 * Parse a fetched app catalog: a JSON object of English source → translation.
 * Anything else (an error page, a non-string value) yields null, and entries
 * over the message limit are dropped.
 */
export function parseOfficialAppCatalog(text: string): LiteralCatalog | null {
	if (text.length > MAX_APP_CATALOG_LENGTH) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const catalog: Record<string, string> = {};
	for (const [source, message] of Object.entries(value)) {
		if (typeof message !== "string") {
			return null;
		}
		if (message.trim() && message.length <= MAX_MESSAGE_LENGTH) {
			catalog[source] = message;
		}
	}
	return catalog;
}

/** Values a Companion frame sends with a message: JSON scalars. */
type HostValues = Readonly<Record<string, string | number | boolean | null>>;

/** The slice of a host i18n runtime a Companion frame's bridge calls. */
export interface AppCatalogHostRuntime {
	getSnapshot(): I18nHostSnapshot;
	subscribe(listener: () => void): () => void;
	t(id: string, values?: HostValues, fallback?: string): string;
}

/** An app catalog for one official locale (see {@link officialAppCatalogKey}). */
export interface LoadedAppCatalog {
	catalog: LiteralCatalog;
	locale: string;
}

function samePlaceholders(left: string, right: string): boolean {
	return (
		JSON.stringify(placeholderNames(left)) ===
		JSON.stringify(placeholderNames(right))
	);
}

/**
 * The opened app's catalog, layered under a host runtime for one Companion
 * frame. The host's own answer wins (a chosen language pack, its bundled
 * catalog); copy it leaves in English is looked up in the app catalog,
 * exactly or as a simple-argument template, the way the host treats its own
 * catalog. The catalog answers only while the host shows its locale, and a
 * catalog that arrives late republishes the host snapshot, so the frame
 * retries what it could not translate.
 */
export class OfficialAppCatalogLayer {
	private loaded: LoadedAppCatalog | null = null;
	private messages = new Map<string, string>();
	private templates: LiteralTemplateIndex | null = null;
	private readonly listeners = new Set<() => void>();

	/** Swap the catalog (null clears it) and tell subscribed frames. */
	setCatalog(loaded: LoadedAppCatalog | null): void {
		if (loaded === this.loaded) {
			return;
		}
		this.loaded = loaded;
		this.messages = loaded ? indexLiteralCatalog(loaded.catalog) : new Map();
		this.templates = null;
		for (const listener of this.listeners) {
			listener();
		}
	}

	/** `runtime` with this catalog under it, for `createI18nHostServices`. */
	over(runtime: AppCatalogHostRuntime): AppCatalogHostRuntime {
		return {
			getSnapshot: () => runtime.getSnapshot(),
			subscribe: (listener) => {
				const unsubscribe = runtime.subscribe(listener);
				this.listeners.add(listener);
				return () => {
					unsubscribe();
					this.listeners.delete(listener);
				};
			},
			t: (id, values, fallback) =>
				this.translate(runtime, id, values ?? {}, fallback),
		};
	}

	private translate(
		runtime: AppCatalogHostRuntime,
		id: string,
		values: HostValues,
		fallback: string | undefined
	): string {
		const hosted = runtime.t(id, values, fallback);
		const loaded = this.loaded;
		const locale = runtime.getSnapshot().locale;
		if (
			!(loaded && fallback?.trim()) ||
			officialCatalogLocale(locale) !== loaded.locale
		) {
			return hosted;
		}
		const plain = isLiteralMessageId(id) && Object.keys(values).length === 0;
		const english = plain ? fallback : formatMessage(fallback, values, locale);
		if (hosted !== fallback && hosted !== english) {
			return hosted;
		}
		const message =
			this.messages.get(id) ?? this.messages.get(messageIdForLiteral(fallback));
		if (message !== undefined && samePlaceholders(message, fallback)) {
			return plain ? message : formatMessage(message, values, locale);
		}
		if (!plain) {
			return hosted;
		}
		this.templates ??= new LiteralTemplateIndex(loaded.catalog);
		return this.templates.match(fallback, locale) ?? hosted;
	}
}
