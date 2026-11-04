import { activeLocale, numberFormatter, parseLocaleNumber } from "@ryu/i18n";

// Same value as MICRO_USD_PER_DOLLAR in @/src/lib/api/credits.ts. Kept local so
// this pure helper does not load the credits API client (and its base URL)
// into tests that set the URL before importing the card.
const MICRO_USD_PER_DOLLAR = 1_000_000;

export interface TopupInput {
	/** The field holds text that is not a non-negative amount in the locale. */
	invalid: boolean;
	/** The amount to move, in micro-USD; 0 while the field is empty or invalid. */
	microUsd: number;
}

/**
 * Read the transfer card's top-up field in the user's locale ("7,5" in
 * German is $7.50). Unreadable text is flagged rather than truncated.
 */
export function readTopupInput(text: string, locale?: string): TopupInput {
	if (!text.trim()) {
		return { invalid: false, microUsd: 0 };
	}
	const dollars = parseLocaleNumber(text, locale);
	if (!Number.isFinite(dollars) || dollars < 0) {
		return { invalid: true, microUsd: 0 };
	}
	return {
		invalid: false,
		microUsd: Math.round(dollars * MICRO_USD_PER_DOLLAR),
	};
}

/** "0.00" written in `locale` ("0,00" in German), for an amount placeholder. */
export function formatMoneyPlaceholder(locale = activeLocale()): string {
	return numberFormatter(locale, { minimumFractionDigits: 2 }).format(0);
}
