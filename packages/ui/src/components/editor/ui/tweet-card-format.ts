import { activeLocale, dateFormatter, numberFormatter } from "@ryu/i18n/lite";
import { useOptionalI18n } from "@ryu/i18n/react";

/** The reader's locale, re-rendering when it changes (standalone: the active locale). */
export function useTweetLocale(): string {
	return useOptionalI18n()?.locale ?? activeLocale();
}

/** A tweet's timestamp in the reader's locale (react-tweet hard-codes en-US). */
export function formatTweetTimestamp(locale: string, date: Date): string {
	return dateFormatter(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

/** A short count in the reader's locale (`1.2K`, `1.2万`). */
export function formatTweetCount(locale: string, count: number): string {
	return numberFormatter(locale, {
		maximumFractionDigits: 1,
		notation: "compact",
	}).format(count);
}
