// Prompt Studio assertion chip details. The Gateway keeps `detail` in English
// and adds a stable `code` with `values`; each code renders here as one whole
// translated message, with numbers in the reader's format ("0,857" in German).
// A result without a known code keeps the English `detail`.

import type { LiteralMessage } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import {
	type AssertionDetail,
	type CodedAssertionResult,
	readAssertionDetail,
} from "@ryuhq/core-client/gateway-assertion-codes.ts";

/** The chip tooltip: a localized message plus, for some codes, raw tool text. */
export interface AssertionDetailText {
	message: string;
	/** Untranslated text from a tool (a regex compiler error), shown as-is. */
	raw?: string;
}

function text(detail: AssertionDetail, key: string): string | null {
	const value = detail.values[key];
	return typeof value === "string" ? value : null;
}

function number(
	detail: AssertionDetail,
	key: string,
	locale: string | undefined
): string | null {
	const value = detail.values[key];
	return typeof value === "number" ? formatNumber(value, locale) : null;
}

function valueMessage(
	detail: AssertionDetail,
	tl: LiteralMessage
): string | null {
	const value = text(detail, "value");
	if (value === null) {
		return null;
	}
	switch (detail.code) {
		case "contains.found":
			return tl('Found "{value}"', { value });
		case "contains.missing":
			return tl('Missing "{value}"', { value });
		case "not_contains.absent":
			return tl('Absent: "{value}"', { value });
		case "not_contains.found":
			return tl('Unexpectedly found "{value}"', { value });
		case "equals.mismatch":
			return tl('Expected exactly "{value}"', { value });
		case "starts_with.match":
			return tl('Starts with "{value}"', { value });
		case "starts_with.mismatch":
			return tl('Does not start with "{value}"', { value });
		default:
			return null;
	}
}

function patternMessage(
	detail: AssertionDetail,
	tl: LiteralMessage
): string | null {
	const pattern = text(detail, "pattern");
	if (pattern === null) {
		return null;
	}
	switch (detail.code) {
		case "regex.matched":
			return tl("Matched /{pattern}/", { pattern });
		case "regex.no_match":
			return tl("No match for /{pattern}/", { pattern });
		case "regex.invalid":
			return tl("Invalid regular expression /{pattern}/", { pattern });
		default:
			return null;
	}
}

function codedMessage(
	detail: AssertionDetail,
	tl: LiteralMessage,
	locale: string | undefined
): string | null {
	switch (detail.code) {
		case "equals.match":
			return tl("Exact match");
		case "json.valid":
			return tl("Valid JSON");
		case "json.invalid":
			return tl("Not valid JSON");
		case "similarity.score": {
			const score = number(detail, "score", locale);
			const threshold = number(detail, "threshold", locale);
			return score === null || threshold === null
				? null
				: tl("Similarity {score}; threshold {threshold}", { score, threshold });
		}
		case "similarity.too_long": {
			const limit = number(detail, "limit", locale);
			return limit === null
				? null
				: tl("Similarity inputs are limited to {limit} characters", {
						limit,
					});
		}
		default:
			return valueMessage(detail, tl) ?? patternMessage(detail, tl);
	}
}

/**
 * The tooltip text for one assertion chip, or `null` when the result has
 * neither a renderable code nor an English detail.
 */
export function assertionDetailText(
	result: CodedAssertionResult,
	tl: LiteralMessage,
	locale?: string
): AssertionDetailText | null {
	const detail = readAssertionDetail(result);
	const coded = detail ? codedMessage(detail, tl, locale) : null;
	if (detail === null || coded === null) {
		return result.detail ? { message: result.detail } : null;
	}
	const message = detail.negated
		? tl("Negated: {detail}", { detail: coded })
		: coded;
	const raw = detail.code === "regex.invalid" ? text(detail, "error") : null;
	return raw ? { message, raw } : { message };
}
