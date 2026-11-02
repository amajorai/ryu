import {
	type CompactAgeOptions,
	type DateInput,
	formatCompactAge,
	formatDateValue,
	formatNumberValue,
	formatRelativeTime,
	type RelativeTimeOptions,
	unitFormatter,
} from "./format-intl.ts";

/**
 * The formatting half of `I18nRuntime`: dates, numbers, ages and units in
 * {@link formatLocale}, which keeps the user's regional tag (`pt-PT`, `es-MX`)
 * while messages come from the pack of that language (`pt-BR`, `es`). This
 * mirrors the CLI's split between its `format` and `messages` locales.
 */
export abstract class I18nFormatting {
	/** The tag dates and numbers format in. */
	abstract get formatLocale(): string;

	formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
		return formatNumberValue(this.formatLocale, value, options);
	}

	formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
		return formatDateValue(this.formatLocale, value, options);
	}

	/** "5 minutes ago", "yesterday", "5分前" (see `format-intl.ts`). */
	formatRelativeTime(value: DateInput, options?: RelativeTimeOptions): string {
		return formatRelativeTime(this.formatLocale, value, options);
	}

	/** A list badge's age: "5m" in English, "5分" in Japanese. */
	formatCompactAge(value: DateInput, options?: CompactAgeOptions): string {
		return formatCompactAge(this.formatLocale, value, options);
	}

	/** A number with a unit: `formatUnit(5, "minute")` is "5m", "5 мин". */
	formatUnit(
		value: number,
		unit: string,
		unitDisplay?: Intl.NumberFormatOptions["unitDisplay"]
	): string {
		return unitFormatter(this.formatLocale, unit, unitDisplay).format(value);
	}
}
