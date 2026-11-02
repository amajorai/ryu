import {
	isLocalizedOutput,
	rememberLocalizedOutput,
} from "./dom-localizer-outputs.ts";
import { formatMessage, type MessageValuesInput } from "./format.ts";
import { isLiteralMessageId, messageIdForLiteral } from "./literal-catalog.ts";
import {
	canonicalLocale,
	directionForLocale,
	findLanguagePackForLocale,
	isEnglishLocale,
	localeLanguageAndScript,
} from "./locale.ts";
import {
	DEFAULT_LOCALE,
	type LanguageDirection,
	type LanguagePack,
	placeholderNames,
	SOURCE_MESSAGES,
	trustedBuiltInPack,
	validateLanguagePack,
} from "./pack.ts";
import { readStoredPackId, writeStoredPackId } from "./pack-storage.ts";
import { I18nFormatting } from "./runtime-format.ts";
import {
	type MessageOverlays,
	RuntimeLiteralCatalogs,
} from "./runtime-literals.ts";

export type { MessageOverlays } from "./runtime-literals.ts";

export interface I18nRuntimeOptions {
	/**
	 * The locale to show while no pack is chosen, or the user's preferred
	 * locales best first (`navigator.languages`): the first one English or
	 * an available pack can show wins, so `["nl-NL", "de"]` shows German.
	 */
	initialLocale?: string | readonly string[] | null;
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
export class I18nRuntime extends I18nFormatting {
	private builtInPacks: readonly LanguagePack[];
	private readonly listeners = new Set<() => void>();
	private packId: string | null;
	private packs: LanguagePack[];
	private readonly persistPackId?: I18nRuntimeOptions["persistPackId"];
	private remotePacks: readonly LanguagePack[] = [];
	private readonly reservedPackIds: ReadonlySet<string>;
	private readonly restoreStoredPackId: boolean;
	private localeOverride: string | null;
	/** Preferred locales, best first, re-tried whenever the packs change. */
	private preferredLocales: readonly string[] = [];
	/** Whether a pack was chosen (given, saved or picked), not auto-detected. */
	private explicitSelection = false;
	/** The regional tag a pack of its language was adopted for (`pt-PT` → pt-BR). */
	private regionalFormat: { locale: string; packId: string } | null = null;
	/** App overlays and official literal catalogs, by language and script. */
	private readonly literals = new RuntimeLiteralCatalogs((key) => {
		if (localeLanguageAndScript(this.locale) === key) {
			this.emit();
		}
	});
	private version = 0;

	constructor(
		packs: readonly LanguagePack[] = [],
		options: I18nRuntimeOptions = {},
		builtIns?: BuiltInLanguagePacks
	) {
		super();
		this.builtInPacks = builtIns?.packs ?? defaultBuiltInPacks;
		this.reservedPackIds = new Set(builtIns?.reservedIds ?? []);
		this.restoreStoredPackId = options.initialPackId === undefined;
		this.packId =
			options.initialPackId === undefined
				? readStoredPackId()
				: options.initialPackId;
		// A given or saved pack is a choice languagechange must not override.
		this.explicitSelection = this.packId !== null;
		this.persistPackId = options.persistPackId;
		this.localeOverride = null;
		this.setPreferredLocales(options.initialLocale);
		this.packs = [];
		this.setOverlays(options.overlays ?? {}, false);
		this.setPacks(packs, false);
	}

	/** Replace the app message overlays (see {@link MessageOverlays}). */
	setOverlays(overlays: MessageOverlays, notify = true): void {
		this.literals.setOverlays(overlays);
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
		return this.literals.overlayMessage(this.locale, id);
	}

	/**
	 * Translate dynamic text with no exact catalog entry (`Deleted Q3 plan`)
	 * through the official literal catalog's simple-argument templates
	 * (`Deleted {name}`). Captured values are inserted verbatim and never
	 * ICU-parsed; only a relayed reason (`{error}`, `{detail}`) that is itself
	 * catalog copy is translated. Undefined when no template matches, and
	 * for a recent translated output. A capture that mixes Latin and
	 * non-Latin letters never fits (`Release notesを選択`), while a value in
	 * the reader's own script does (`Deleted 田中`).
	 */
	templateMessage(text: string): string | undefined {
		if (isLocalizedOutput(text)) {
			return;
		}
		return this.literals.templateMessage(this.locale, text);
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
		if (this.packId === null) {
			this.adoptPreferredLocale();
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
		this.explicitSelection ||= this.packId !== null;
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

	/**
	 * The tag dates and numbers format in: the user's own regional tag when a
	 * pack of its language was adopted for it (`pt-PT` reading the pt-BR pack,
	 * `es-MX` the es pack), otherwise {@link locale}. Never a catalog key.
	 */
	get formatLocale(): string {
		const regional = this.regionalFormat;
		return regional && regional.packId === this.selectedPack?.id
			? regional.locale
			: this.locale;
	}

	get direction(): LanguageDirection {
		return this.selectedPack?.direction ?? directionForLocale(this.locale);
	}

	selectPack(id: string | null): void {
		if (id !== null && !this.packs.some((pack) => pack.id === id)) {
			return;
		}
		this.explicitSelection = true;
		this.regionalFormat = null;
		this.choosePack(id);
	}

	private choosePack(id: string | null): void {
		this.packId = id;
		this.localeOverride = null;
		this.preferredLocales = [];
		if (this.persistPackId) {
			void this.persistPackId(id);
		} else {
			writeStoredPackId(id);
		}
		this.emit();
	}

	/** Store canonical preferences; the first is shown until a pack is found. */
	private setPreferredLocales(
		locales: string | readonly string[] | null | undefined
	): void {
		const list = typeof locales === "string" ? [locales] : (locales ?? []);
		const canonical: string[] = [];
		for (const locale of list) {
			const tag = locale ? canonicalLocale(locale, "") : "";
			if (tag && !canonical.includes(tag)) {
				canonical.push(tag);
			}
		}
		this.preferredLocales = canonical;
		this.localeOverride = canonical[0] ?? null;
		this.regionalFormat = null;
	}

	/**
	 * Show the first preferred locale English, a pack or a literal catalog
	 * can show: English or a catalog keeps that locale (no pack), a pack is
	 * selected. When none can, the first preference stays the locale.
	 * Returns the adopted pack id, if any.
	 */
	private adoptPreferredLocale(): string | null {
		for (const locale of this.preferredLocales) {
			if (isEnglishLocale(locale)) {
				this.localeOverride = locale;
				return null;
			}
			const pack = this.findPackForLocale(locale);
			if (pack) {
				this.regionalFormat =
					pack.locale === locale ? null : { locale, packId: pack.id };
				this.packId = pack.id;
				this.localeOverride = null;
				this.preferredLocales = [];
				return pack.id;
			}
			// No pack, but an official literal catalog or app overlay can show
			// it (catalog-only surfaces); a pack installed later still wins.
			if (this.literals.serves(locale)) {
				this.localeOverride = locale;
				return null;
			}
		}
		return null;
	}

	/**
	 * Follow a change of the system's preferred languages (`languagechange`)
	 * while the language is automatic: nothing is persisted, and a pack the
	 * user picked with {@link selectPack} is kept. Publishes only on change.
	 */
	applySystemLocales(locales: readonly string[]): void {
		if (this.explicitSelection || locales.length === 0) {
			return;
		}
		const before = `${this.packId}\u0000${this.formatLocale}`;
		this.packId = null;
		this.setPreferredLocales(locales);
		this.adoptPreferredLocale();
		if (`${this.packId}\u0000${this.formatLocale}` !== before) {
			this.emit();
		}
	}

	/** Show `locale` (or the first of a preference list that can be shown). */
	setLocale(locale: string | readonly string[]): void {
		this.packId = null;
		this.setPreferredLocales(locale);
		const packId = this.adoptPreferredLocale();
		if (packId) {
			this.choosePack(packId);
			return;
		}
		this.localeOverride ??= DEFAULT_LOCALE;
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
				return this.localized(templated);
			}
		}
		// Only a catalog translation that differs from its English is marked
		// for the DOM localizer; English fallbacks stay open to it.
		const translated = message !== undefined && message !== source;
		if (message === undefined) {
			message = [fallback, SOURCE_MESSAGES.get(id)].find(fits) ?? id;
			resolvedId = id;
		}
		const output =
			isLiteralMessageId(resolvedId) && Object.keys(values ?? {}).length === 0
				? message
				: formatMessage(message, values, this.formatLocale);
		return translated ? this.localized(output) : output;
	}

	/** Mark `output` as translated, so the DOM localizer leaves it alone. */
	private localized(output: string): string {
		rememberLocalizedOutput(this.locale, output);
		return output;
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
