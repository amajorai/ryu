import { activeLocale } from "@ryu/i18n/lite";
import { useOptionalI18n } from "@ryu/i18n/react";

/** A locale EmojiMart ships a translation for (`@emoji-mart/data/i18n/<code>.json`). */
export type EmojiMartLocale =
	| "en"
	| "ar"
	| "de"
	| "es"
	| "fr"
	| "hi"
	| "it"
	| "ja"
	| "ko"
	| "pt"
	| "ru"
	| "zh";

/** EmojiMart's picker strings (search placeholder, category names, skin tones). */
export type EmojiMartI18n = Record<string, unknown>;

// One literal import per locale so bundlers split each translation into its
// own lazily loaded chunk; without `i18n` EmojiMart fetches it from a CDN.
const I18N_LOADERS: Record<
	Exclude<EmojiMartLocale, "en">,
	() => Promise<{ default: EmojiMartI18n }>
> = {
	ar: () => import("@emoji-mart/data/i18n/ar.json"),
	de: () => import("@emoji-mart/data/i18n/de.json"),
	es: () => import("@emoji-mart/data/i18n/es.json"),
	fr: () => import("@emoji-mart/data/i18n/fr.json"),
	hi: () => import("@emoji-mart/data/i18n/hi.json"),
	it: () => import("@emoji-mart/data/i18n/it.json"),
	ja: () => import("@emoji-mart/data/i18n/ja.json"),
	ko: () => import("@emoji-mart/data/i18n/ko.json"),
	pt: () => import("@emoji-mart/data/i18n/pt.json"),
	ru: () => import("@emoji-mart/data/i18n/ru.json"),
	zh: () => import("@emoji-mart/data/i18n/zh.json"),
};

function isTranslatedLocale(
	language: string
): language is Exclude<EmojiMartLocale, "en"> {
	return Object.hasOwn(I18N_LOADERS, language);
}

/**
 * The EmojiMart locale for a Ryu UI locale: the base language (`pt-BR` → `pt`,
 * `zh-CN` → `zh`) when EmojiMart translates it, otherwise English.
 */
export function emojiMartLocale(locale: string): EmojiMartLocale {
	const language = locale.trim().split(/[-_]/u)[0]?.toLowerCase() ?? "";
	return isTranslatedLocale(language) ? language : "en";
}

/** Lazily load EmojiMart's translation; `undefined` keeps its built-in English. */
export function emojiMartI18nLoader(
	locale: EmojiMartLocale
): (() => Promise<EmojiMartI18n>) | undefined {
	if (locale === "en") {
		return;
	}
	const load = I18N_LOADERS[locale];
	return () => load().then((module) => module.default);
}

export interface EmojiMartLocaleProps {
	/** Translation loader; EmojiMart also takes text direction (`rtl`) from it. */
	i18n?: () => Promise<EmojiMartI18n>;
	/** Also the remount key: EmojiMart reads `locale`/`i18n` only on creation. */
	locale: EmojiMartLocale;
}

/** EmojiMart locale props for an explicit Ryu UI locale. */
export function emojiMartLocaleProps(locale: string): EmojiMartLocaleProps {
	const code = emojiMartLocale(locale);
	return { i18n: emojiMartI18nLoader(code), locale: code };
}

/**
 * EmojiMart locale props for the mounted provider's UI locale, or the active
 * locale when a picker renders outside a provider.
 */
export function useEmojiMartLocaleProps(): EmojiMartLocaleProps {
	const locale = useOptionalI18n()?.locale ?? activeLocale();
	return emojiMartLocaleProps(locale);
}
