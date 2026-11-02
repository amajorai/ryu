/**
 * Marks English landing copy in a data table (a tuple row, a Map value, a
 * prop the i18n extractor does not read by name) and returns it unchanged.
 * Import it as `t` (`import { copyMarker as t } from "./copy-marker.ts"`) so
 * the extractor records the literal as a catalog key. The table stays
 * English; the component that renders it translates the value with
 * `useLiteralMessages()` (or, on a server page, the DOM localizer matches
 * the same catalog literal).
 */
export const copyMarker = (source: string): string => source;
