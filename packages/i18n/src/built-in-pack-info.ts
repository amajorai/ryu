import type { LanguagePack } from "./pack.ts";

/** A pack's identity without its messages: enough to list, reserve or match it. */
export type LanguagePackInfo = Pick<
	LanguagePack,
	"baseLocale" | "direction" | "id" | "locale" | "name"
>;

/**
 * The built-in packs of `messages.ts`, in the same order, without their
 * catalogs. A web page can list, reserve and auto-detect first-party voices
 * from this and load the catalog only when a visitor needs it.
 * `built-in-packs.test.ts` keeps it identical to `BUILT_IN_LANGUAGE_PACKS`.
 */
export const BUILT_IN_LANGUAGE_PACK_INFO: readonly LanguagePackInfo[] = [
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/es",
		locale: "es",
		name: "Español",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/fr",
		locale: "fr",
		name: "Français",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/de",
		locale: "de",
		name: "Deutsch",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/pt-br",
		locale: "pt-BR",
		name: "Português (Brasil)",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/ja",
		locale: "ja",
		name: "日本語",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/zh-cn",
		locale: "zh-CN",
		name: "简体中文",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/it",
		locale: "it",
		name: "Italiano",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/ko",
		locale: "ko",
		name: "한국어",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/hi",
		locale: "hi",
		name: "हिन्दी",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "official/ru",
		locale: "ru",
		name: "Русский",
	},
	{
		baseLocale: "en",
		direction: "rtl",
		id: "official/ar",
		locale: "ar",
		name: "العربية",
	},
	{
		baseLocale: "en",
		direction: "ltr",
		id: "en-x-ryu-online",
		locale: "en",
		name: "English (chronically online)",
	},
];
