/** Character handling shared by `OTPInput` and `OTPCodeDisplay`. */

export const NUMERIC_KEY = /^[0-9]$/;
export const ALPHANUMERIC_KEY = /^[0-9a-zA-Z]$/;
const NON_NUMERIC = /[^0-9]/g;
export const NON_ALPHANUMERIC = /[^0-9A-Z]/g;

export function strip(raw: string, alphanumeric: boolean) {
	return alphanumeric
		? raw.toUpperCase().replace(NON_ALPHANUMERIC, "")
		: raw.replace(NON_NUMERIC, "");
}

export function sanitize(raw: string, length: number, alphanumeric: boolean) {
	return strip(raw, alphanumeric).slice(0, length);
}

export function toSlots(raw: string, length: number, alphanumeric: boolean) {
	const chars = sanitize(raw, length, alphanumeric);
	return Array.from({ length }, (_, i) => chars[i] ?? "");
}
