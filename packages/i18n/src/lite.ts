// `@ryu/i18n/lite`: the runtime, validation and formatting without the bundled
// first-party catalogs, the zip codec or a schema library. Built-in packs are
// known here only by `BUILT_IN_LANGUAGE_PACK_INFO`; a host that uses this entry
// passes the catalogs it has loaded to the runtime (see `@ryu/i18n/react-lite`)
// and imports `@ryu/i18n/messages` lazily for the rest.

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
	LANGUAGE_PACK_SCHEMA_VERSION,
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguageDirection,
	type LanguagePack,
	type LanguagePackSummary,
	LanguagePackValidationError,
	type LanguagePackValidationIssue,
	languagePackSummary,
	MAX_MESSAGE_LENGTH,
	parseLanguagePackJson,
	validateLanguagePack,
} from "./pack.ts";
export {
	type BuiltInLanguagePacks,
	type I18nHostSnapshot,
	type I18nHostTranslateInput,
	I18nRuntime,
	type I18nRuntimeOptions,
	type MessageOverlays,
} from "./runtime.ts";
