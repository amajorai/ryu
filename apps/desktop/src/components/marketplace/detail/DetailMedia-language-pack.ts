import type { LanguagePackSummary } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * A language pack's information row as one catalogued template, so the
 * localizer translates the whole row (the " · " joins block a shorter match).
 */
export function languagePackRowValue(
	pack: LanguagePackSummary,
	tl: LiteralMessage
): string {
	return tl(
		"{locale} · {baseLocale} · {direction} · {messageCount, plural, one {# string} other {# strings}}",
		{
			baseLocale: pack.baseLocale,
			direction: pack.direction.toUpperCase(),
			locale: pack.locale,
			messageCount: pack.messageCount,
		}
	);
}
