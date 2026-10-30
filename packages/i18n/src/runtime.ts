import { formatMessage, type MessageValuesInput } from "./format.ts";
import {
	indexLiteralCatalog,
	isLiteralMessageId,
	type LiteralCatalogLoader,
	literalCatalogLoader,
	messageIdForLiteral,
} from "./literal-catalog.ts";
import { LiteralTemplateIndex } from "./literal-templates.ts";
import {
	canonicalLocale,
	directionForLocale,
	findLanguagePackForLocale,
	localeLanguageAndScript,
} from "./locale.ts";
import {
	DEFAULT_LOCALE,
	LANGUAGE_PACK_STORAGE_KEY,
	type LanguageDirection,
	type LanguagePack,
	MAX_MESSAGE_LENGTH,
	placeholderNames,
	SOURCE_MESSAGES,
	trustedBuiltInPack,
	validateLanguagePack,
} from "./pack.ts";

function readStoredPackId(): string | null {
	try {
		return localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStoredPackId(value: string | null): void {
	try {
		if (value) {
			localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, value);
		} else {
			localStorage.removeItem(LANGUAGE_PACK_STORAGE_KEY);
		}
	} catch {
		// Private browsing and restricted webviews can deny storage. The in-memory
		// selection still works for the current session.
	}
}

/**
 * App-owned message catalogs layered under the selected language pack:
 * locale (such as `es` or `pt-BR`) → English source literal → translation.
 * A Companion app ships these for its own copy; they never shadow a pack's
 * message and are keyed by the same literal ids the DOM localizer uses.
 */
export type MessageOverlays = Readonly<
	Record<string, Readonly<Record<string, string>>>
>;

export interface I18nRuntimeOptions {
	initialLocale?: string | null;
	initialPackId?: string | null;
	/** App message catalogs consulted after the selected pack. */
	overlays?: MessageOverlays;
	/** Optional persistence adapter for native hosts without localStorage. */
	persistPackId?: (id: string | null) => void | Promise<void>;
}

/**
 * First-party packs a runtime holds. `packs` are trusted, already-checked
 * catalogs (see `trustedBuiltInPack`); `reservedIds` names first-party ids a
 * remote pack may never take, including ones whose catalog is not loaded yet.
 */
export interface BuiltInLanguagePacks {
	packs: readonly LanguagePack[];
	reservedIds?: readonly string[];
}

/** The small, serializable snapshot exposed to sandboxed apps and plugins. */
export interface I18nHostSnapshot {
	direction: LanguageDirection;
	locale: string;
	packId: string | null;
	packName: string | null;
	packVersion: string | null;
}

/** A translation request crossing an app/plugin host boundary. */
export interface I18nHostTranslateInput {
	defaultMessage: string;
	id: string;
	values?: Record<string, string | number | boolean | null>;
}

let defaultBuiltInPacks: readonly LanguagePack[] = [];

/** Shared runtime used by the website, desktop, and the browser-hosted webapp. */
export class I18nRuntime {
	private builtInPacks: readonly LanguagePack[];
	private readonly listeners = new Set<() => void>();
	private packId: string | null;
	private packs: LanguagePack[];
	private readonly persistPackId?: I18nRuntimeOptions["persistPackId"];
	private remotePacks: readonly LanguagePack[] = [];
	private readonly reservedPackIds: ReadonlySet<string>;
	private readonly restoreStoredPackId: boolean;
	private localeOverride: string | null;
	/** Overlay messages by language-and-script key, then message id. */
	private overlays = new Map<string, Map<string, string>>();
	/** Official literal catalogs by language-and-script key; null while loading. */
	private readonly literalCatalogs = new Map<
		string,
		Map<string, string> | null
	>();
	/** Simple-argument templates of each loaded literal catalog, built lazily. */
	private readonly literalTemplates = new Map<string, LiteralTemplateIndex>();
	private version = 0;

	constructor(
		packs: readonly LanguagePack[] = [],
		options: I18nRuntimeOptions = {},
		builtIns?: BuiltInLanguagePacks
	) {
		this.builtInPacks = builtIns?.packs ?? defaultBuiltInPacks;
		this.reservedPackIds = new Set(builtIns?.reservedIds ?? []);
		this.restoreStoredPackId = options.initialPackId === undefined;
		this.packId =
			options.initialPackId === undefined
				? readStoredPackId()
				: options.initialPackId;
		this.persistPackId = options.persistPackId;
		this.localeOverride = options.initialLocale
			? canonicalLocale(options.initialLocale, DEFAULT_LOCALE)
			: null;
		this.packs = [];
		this.setOverlays(options.overlays ?? {}, false);
		this.setPacks(packs, false);
	}

	/** Replace the app message overlays (see {@link MessageOverlays}). */
	setOverlays(overlays: MessageOverlays, notify = true): void {
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
		if (notify) {
			this.emit();
		}
	}

	/**
	 * The app overlay message for `id` in the current locale, then the official
	 * literal catalog's. The first lookup in a locale starts loading its catalog
	 * and publishes once it arrives, so consumers re-render translated.
	 */
	overlayMessage(id: string): string | undefined {
		const key = localeLanguageAndScript(this.locale);
		return (
			this.overlays.get(key)?.get(id) ?? this.literalCatalogMessage(key, id)
		);
	}

	/**
	 * Translate dynamic text with no exact catalog entry (`Deleted Q3 plan`)
	 * through the official literal catalog's simple-argument templates
	 * (`Deleted {name}`). Captured values are inserted verbatim, never
	 * re-translated or ICU-parsed. Undefined when no template matches.
	 */
	templateMessage(text: string): string | undefined {
		const loader = literalCatalogLoader();
		if (loader === null || this.locale === DEFAULT_LOCALE) {
			return;
		}
		const key = localeLanguageAndScript(this.locale);
		if (!this.literalCatalogs.has(key)) {
			this.loadLiteralCatalog(key, loader);
		}
		return this.literalTemplates.get(key)?.match(text, this.locale);
	}

	private literalCatalogMessage(key: string, id: string): string | undefined {
		const loader = literalCatalogLoader();
		if (loader === null || this.locale === DEFAULT_LOCALE) {
			return;
		}
		const catalog = this.literalCatalogs.get(key);
		if (catalog === undefined) {
			return this.loadLiteralCatalog(key, loader)?.get(id);
		}
		return catalog?.get(id);
	}

	/** Index the catalog for `key`; returns it when the loader answered synchronously. */
	private loadLiteralCatalog(
		key: string,
		loader: LiteralCatalogLoader
	): Map<string, string> | null {
		let result: ReturnType<LiteralCatalogLoader>;
		try {
			result = loader(this.locale);
		} catch {
			result = null;
		}
		if (!(result instanceof Promise)) {
			const catalog = indexLiteralCatalog(result ?? {});
			this.literalCatalogs.set(key, catalog);
			this.literalTemplates.set(key, new LiteralTemplateIndex(result ?? {}));
			return catalog;
		}
		this.literalCatalogs.set(key, null);
		result
			.then((catalog) => {
				this.literalCatalogs.set(key, indexLiteralCatalog(catalog ?? {}));
				this.literalTemplates.set(key, new LiteralTemplateIndex(catalog ?? {}));
				if (catalog && localeLanguageAndScript(this.locale) === key) {
					this.emit();
				}
			})
			.catch(() => {
				// A missing chunk leaves the locale on its pack and English fallback;
				// keep the empty entry so lookups do not retry on every render.
				this.literalCatalogs.set(key, new Map());
			});
		return null;
	}

	getVersion = (): number => this.version;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		this.version += 1;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private findPackForLocale(locale: string): LanguagePack | null {
		return findLanguagePackForLocale(this.packs, locale);
	}

	setPacks(packs: readonly LanguagePack[], notify = true): void {
		this.remotePacks = packs;
		const next = new Map<string, LanguagePack>();
		for (const pack of this.builtInPacks) {
			next.set(pack.id, trustedBuiltInPack(pack));
		}
		for (const pack of packs) {
			// Built-in ids are reserved. A remote pack must not be able to shadow a
			// first-party voice and silently change the default fallback surface.
			if (next.has(pack.id) || this.reservedPackIds.has(pack.id)) {
				continue;
			}
			try {
				const validated = validateLanguagePack(pack);
				next.set(validated.id, {
					...validated,
					enabled: pack.enabled !== false,
				});
			} catch {
				// An invalid remote pack is isolated; the canonical catalog remains
				// usable and another installed pack can still load.
			}
		}
		this.packs = [...next.values()];
		this.readPendingStoredPackId();
		if (this.packId === null && this.localeOverride) {
			const localePack = this.findPackForLocale(this.localeOverride);
			if (localePack) {
				this.packId = localePack.id;
				this.localeOverride = null;
			}
		}
		if (notify) {
			this.emit();
		}
	}

	/**
	 * Replace the first-party catalogs, for a host that loads them after
	 * construction, and re-apply the current remote packs exactly as
	 * {@link setPacks} does.
	 */
	setBuiltInPacks(packs: readonly LanguagePack[], notify = true): void {
		this.builtInPacks = packs;
		this.setPacks(this.remotePacks, notify);
	}

	/**
	 * While no pack is selected, a runtime that restores the saved choice takes
	 * a pack id saved since it last looked. Returns whether it took one.
	 */
	private readPendingStoredPackId(): boolean {
		if (this.packId !== null || !this.restoreStoredPackId) {
			return false;
		}
		this.packId = readStoredPackId();
		return this.packId !== null;
	}

	/**
	 * Re-read the saved pack id exactly as {@link setPacks} does, for a host
	 * whose catalog did not change. Publishes only when a saved id is adopted,
	 * so an unchanged refresh stays silent.
	 */
	adoptStoredPackId(): boolean {
		if (!this.readPendingStoredPackId()) {
			return false;
		}
		this.emit();
		return true;
	}

	get availablePacks(): readonly LanguagePack[] {
		return this.packs;
	}

	get selectedPackId(): string | null {
		return this.packId;
	}

	get selectedPack(): LanguagePack | null {
		const pack = this.packs.find((candidate) => candidate.id === this.packId);
		return pack?.enabled === false ? null : (pack ?? null);
	}

	getSnapshot = (): I18nHostSnapshot => {
		const selected = this.selectedPack;
		return {
			direction: this.direction,
			locale: this.locale,
			packId: selected?.id ?? null,
			packName: selected?.name ?? null,
			packVersion: selected?.version ?? null,
		};
	};

	get locale(): string {
		return this.selectedPack?.locale ?? this.localeOverride ?? DEFAULT_LOCALE;
	}

	get direction(): LanguageDirection {
		return this.selectedPack?.direction ?? directionForLocale(this.locale);
	}

	selectPack(id: string | null): void {
		if (id !== null && !this.packs.some((pack) => pack.id === id)) {
			return;
		}
		this.packId = id;
		this.localeOverride = null;
		if (this.persistPackId) {
			void this.persistPackId(id);
		} else {
			writeStoredPackId(id);
		}
		this.emit();
	}

	setLocale(locale: string): void {
		const canonical = canonicalLocale(locale, DEFAULT_LOCALE);
		const pack = this.findPackForLocale(canonical);
		if (pack) {
			this.selectPack(pack.id);
			return;
		}
		this.packId = null;
		this.localeOverride = canonical;
		if (this.persistPackId) {
			void this.persistPackId(null);
		} else {
			writeStoredPackId(null);
		}
		this.emit();
	}

	/**
	 * Resolve `id` through the selected pack, app overlays and official
	 * literal catalog, then the base pack. When none has it and a `fallback`
	 * is given, the fallback's own literal entry is tried, so keyed copy
	 * (`t("app.key", {}, "Save draft")`) still reaches the literal catalog.
	 * A literal id looked up without values (DOM text, host relays) returns
	 * its translation or fallback verbatim: such text may be data and is
	 * never run through ICU formatting. With no catalog entry, its fallback
	 * is tried against the catalog's templates ({@link templateMessage}).
	 */
	translate(
		id: string,
		values: MessageValuesInput = {},
		fallback?: string
	): string {
		const source = SOURCE_MESSAGES.get(id) ?? fallback;
		const fits = (candidate: string | undefined): candidate is string =>
			candidate !== undefined &&
			(!source ||
				JSON.stringify(placeholderNames(candidate)) ===
					JSON.stringify(placeholderNames(source)));
		let resolvedId = id;
		let message = this.translatedCandidates(id).find(fits);
		if (message === undefined && fallback?.trim()) {
			const fallbackId = messageIdForLiteral(fallback);
			if (fallbackId !== id) {
				message = this.translatedCandidates(fallbackId).find(fits);
				resolvedId = fallbackId;
			}
		}
		if (
			message === undefined &&
			fallback?.trim() &&
			isLiteralMessageId(id) &&
			Object.keys(values ?? {}).length === 0
		) {
			// Dynamic literal text (DOM, host relays): try the catalog templates.
			const templated = this.templateMessage(fallback);
			if (templated !== undefined) {
				return templated;
			}
		}
		if (message === undefined) {
			message = [fallback, SOURCE_MESSAGES.get(id)].find(fits) ?? id;
			resolvedId = id;
		}
		if (
			isLiteralMessageId(resolvedId) &&
			Object.keys(values ?? {}).length === 0
		) {
			return message;
		}
		return formatMessage(message, values, this.locale);
	}

	/** Translated messages for `id`: selected pack, overlays/catalog, base pack. */
	private translatedCandidates(id: string): (string | undefined)[] {
		const selected = this.selectedPack;
		const base =
			selected && selected.baseLocale !== DEFAULT_LOCALE
				? this.packs.find(
						(pack) =>
							pack.enabled !== false &&
							pack.locale === selected.baseLocale &&
							pack.id !== selected.id
					)
				: null;
		return [
			selected?.messages[id],
			this.overlayMessage(id),
			base?.messages[id],
		];
	}

	formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
		return new Intl.NumberFormat(this.locale, options).format(value);
	}

	formatDate(
		value: Date | number | string,
		options?: Intl.DateTimeFormatOptions
	): string {
		return new Intl.DateTimeFormat(this.locale, options).format(
			new Date(value)
		);
	}
}

/**
 * Set the packs a runtime constructed without explicit built-ins starts from,
 * and return the runtime class. `@ryu/i18n/core` exports its `I18nRuntime` as
 * this call's result, so any bundle that can construct a runtime through that
 * entry also keeps the call that installs the bundled catalog.
 */
export function installDefaultBuiltInLanguagePacks(
	packs: readonly LanguagePack[]
): typeof I18nRuntime {
	defaultBuiltInPacks = packs;
	return I18nRuntime;
}
