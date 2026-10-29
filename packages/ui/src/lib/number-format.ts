/** Native numeric formatting rejects non-numbers without coercing them. The ticker
 * owns String presentation for those operands, including legacy stored counts. */
/** Native conversion reads these method slots lazily, and permits malformed slots
 * to produce their original errors. Function, Date, proxy and null-prototype
 * operands retain their native identities and additional fields. */
export interface NativeCountConversion {
	toString?: unknown;
	valueOf?: unknown;
	[Symbol.toPrimitive]?: unknown;
}
export type CountFormattingInput =
	| number
	| string
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| NativeCountConversion;

const MILLION = 1_000_000;

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 3,
});

const MILLION_FORMATTER = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 1,
});

function isFiniteNumber(value: CountFormattingInput): value is number {
	return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * Format a count without hiding the thousands digit-by-digit.
 *
 * Counts below one million use comma separators (`1,234`); million-scale
 * counts use a compact, lowercase suffix (`1.2m`). This is the display policy
 * shared by the website and desktop app.
 */
export function formatCount(value: CountFormattingInput): string | null {
	if (!isFiniteNumber(value)) {
		return null;
	}

	if (Math.abs(value) >= MILLION) {
		return `${MILLION_FORMATTER.format(value / MILLION)}m`;
	}

	return Number.isInteger(value)
		? INTEGER_FORMATTER.format(value)
		: NUMBER_FORMATTER.format(value);
}

/** Format a required numeric readout, returning an em dash for bad input. */
export function formatNumber(value: number | null | undefined): string {
	return formatCount(value) ?? "—";
}

function formatCurrencyParts(
	value: number,
	currency: string,
	options: Intl.NumberFormatOptions
): string {
	const formatter = new Intl.NumberFormat("en-US", {
		currency: currency.toUpperCase(),
		style: "currency",
		...options,
	});
	return formatter.format(value);
}

/**
 * Format a currency amount in its display unit.
 *
 * Normal amounts keep currency decimals and comma separators. Values at or
 * above one million use a lowercase compact suffix (`$1.2m`) so a large
 * balance does not overwhelm a card or table row.
 */
export function formatCurrency(
	value: number | null | undefined,
	currency = "USD",
	options: Intl.NumberFormatOptions = {}
): string {
	if (!isFiniteNumber(value)) {
		return "—";
	}

	if (Math.abs(value) >= MILLION) {
		const parts = new Intl.NumberFormat("en-US", {
			compactDisplay: "short",
			currency: currency.toUpperCase(),
			maximumFractionDigits: 1,
			minimumFractionDigits: 0,
			notation: "compact",
			style: "currency",
		}).formatToParts(value);
		return parts
			.map((part) =>
				part.type === "compact" ? part.value.toLowerCase() : part.value
			)
			.join("");
	}

	return formatCurrencyParts(value, currency, options);
}

/** Format integer minor currency units such as cents. */
export function formatMinorCurrency(
	minor: number | null | undefined,
	currency = "USD",
	options: Intl.NumberFormatOptions = {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	}
): string {
	return formatCurrency(
		isFiniteNumber(minor) ? minor / 100 : null,
		currency,
		options
	);
}

/** Format integer micro-USD units while retaining sub-cent usage precision. */
export function formatMicroUsd(
	microUsd: number | null | undefined,
	currency = "USD",
	maximumFractionDigits = 4
): string {
	return formatCurrency(
		isFiniteNumber(microUsd) ? microUsd / MILLION : null,
		currency,
		{
			maximumFractionDigits,
			minimumFractionDigits: 2,
		}
	);
}
