"use client";

import { useOptionalI18n } from "@ryu/i18n/react";
import { formatIsoDate } from "./format-date.ts";

/**
 * An ISO date ("2026-04-12" or "2026-04") in a `<time dateTime>`, formatted
 * for the page language. A client leaf, so server-rendered lists (press,
 * careers, events, security) read the mounted I18nProvider's locale; without
 * a provider it keeps the English form.
 */
export function IsoDateText({ value }: { value: string }) {
	const locale = useOptionalI18n()?.locale;
	return <time dateTime={value}>{formatIsoDate(value, locale)}</time>;
}
