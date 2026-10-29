import { findLanguagePackForLocale } from "./locale.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import type { LanguagePack } from "./pack.ts";
import {
	type I18nRuntime as I18nRuntimeInstance,
	installDefaultBuiltInLanguagePacks,
} from "./runtime.ts";

// `@ryu/i18n/core`: the runtime with the bundled first-party catalogs, which
// become every runtime's default built-in packs, so hosts that construct
// `new I18nRuntime()` render offline in any official language. A page that
// must not ship every catalog builds on `@ryu/i18n/lite` instead.

export {
	languagePackArchive,
	languagePackPortableManifest,
	parseLanguagePackArchive,
} from "./archive.ts";
export {
	BUILT_IN_LANGUAGE_PACK_INFO,
	type LanguagePackInfo,
} from "./built-in-pack-info.ts";
export { formatMessage, type MessageValuesInput } from "./format.ts";
export {
	type LiteralCatalog,
	type LiteralCatalogLoader,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "./literal-catalog.ts";
export {
	directionForLocale,
	findLanguagePackForLocale,
	localeFromAcceptLanguage,
} from "./locale.ts";
export { literalMessageId } from "./message-id.ts";
export {
	DEFAULT_LOCALE,
	LANGUAGE_PACK_ARTIFACT,
	LANGUAGE_PACK_SCHEMA_VERSION,
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguageDirection,
	type LanguagePack,
	type LanguagePackSummary,
	LanguagePackValidationError,
	type LanguagePackValidationIssue,
	languagePackJson,
	languagePackSummary,
	MAX_LANGUAGE_PACK_ARCHIVE_BYTES,
	MAX_LANGUAGE_PACK_BYTES,
	MAX_MESSAGE_LENGTH,
	parseLanguagePackJson,
	validateLanguagePack,
} from "./pack.ts";
export type {
	BuiltInLanguagePacks,
	I18nHostSnapshot,
	I18nHostTranslateInput,
	I18nRuntimeOptions,
	MessageOverlays,
} from "./runtime.ts";

/** Shared runtime used by the website, desktop, and the browser-hosted webapp. */
export const I18nRuntime = installDefaultBuiltInLanguagePacks(
	BUILT_IN_LANGUAGE_PACKS
);
export type I18nRuntime = I18nRuntimeInstance;

/**
 * The built-in pack a request locale auto-selects, exactly as a runtime
 * constructed with `initialLocale: locale` would select it, or null (English
 * and unsupported locales). A server hands this one pack to a page that loads
 * the rest of the catalog lazily, so its first render matches the server's.
 */
export function builtInLanguagePackForLocale(
	locale: string | null | undefined
): LanguagePack | null {
	return locale
		? findLanguagePackForLocale(BUILT_IN_LANGUAGE_PACKS, locale)
		: null;
}
