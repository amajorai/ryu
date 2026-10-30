// `@ryu/i18n/react`: the provider with every bundled first-party catalog, plus
// the catalog-free context, hooks and DOM localizer shared with
// `@ryu/i18n/react-lite`.
//
// This entry only re-exports. The package declares its modules side-effect
// free (except the catalog-registering `official-catalog*.ts`), so a bundle
// that imports just the hooks from here does not include `react-provider.tsx`
// or the catalogs it imports. Each re-exported module is its own client
// boundary.

export type { CompanionI18nApi } from "./dom-localizer-host.ts";
export {
	I18nText,
	useI18n,
	useLocalizedString,
	useLocalizedText,
	useOptionalI18n,
} from "./react-context.tsx";
export { localizeDomRoot } from "./react-dom-localizer.tsx";
export { I18nProvider } from "./react-provider.tsx";
export type { I18nProviderProps } from "./react-provider-base.tsx";
export {
	type RichLiteralMessage,
	type RichTags,
	useRichLiteralMessages,
} from "./react-rich-text.tsx";
export { type LiteralMessage, useLiteralMessages } from "./react-text.tsx";
