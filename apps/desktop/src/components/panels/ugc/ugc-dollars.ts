// Typed USD amounts for the UGC campaign dialog (budget, payout rule, per-creator
// cap). The fields are type="text" with inputMode="decimal", so a German user
// types "12,50"; the old dot-only pattern refused that.

import { activeLocale, localeSeparators, parseLocaleNumber } from "@ryu/i18n";

const AMOUNT_RE = /^(\d+)(?:([^\d])(\d{1,2}))?$/;
const NATIVE_DIGIT_RE = /\p{Nd}/gu;

/** Fold native digits ("١٢" in ar-EG, full-width "１２") onto ASCII, so the
 *  digit-wise match below reads them the way parseLocaleNumber does. */
function asciiDigits(text: string): string {
	return text.replace(NATIVE_DIGIT_RE, (digit) => {
		const value = parseLocaleNumber(digit, "en");
		return Number.isInteger(value) ? String(value) : digit;
	});
}

/** Accepts `12`, `12.5`, `$12.50` and, where the locale writes a comma decimal,
 *  `12,50`. Returns integer cents, or null when the text is not a money amount.
 *  Parsed digit-wise so a typed amount never round-trips through a float. Group
 *  separators are refused ("1.200" in de is not read as 1.20), as before. */
export function dollarsToCents(
	input: string,
	locale: string | null | undefined = activeLocale()
): number | null {
	const body = asciiDigits(input)
		.trim()
		.replace(/^\$\s*/, "")
		.trim();
	const match = AMOUNT_RE.exec(body);
	if (!match) {
		return null;
	}
	const separator = match[2];
	if (separator !== undefined) {
		const { decimal } = localeSeparators(locale);
		if (separator !== "." && separator !== decimal) {
			return null;
		}
	}
	const whole = Number.parseInt(match[1] ?? "0", 10);
	const fraction = (match[3] ?? "").padEnd(2, "0");
	return whole * 100 + Number.parseInt(fraction, 10);
}
