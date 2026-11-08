// Stable detail codes on Gateway eval assertion results.
//
// Gateway API text stays English by policy: `AssertionResult.detail` is the
// English fallback. Deterministic assertions also carry an additive `code` and
// its `values`, which a client renders as one whole localized message. A result
// without a code (an older saved run, a judge verdict, a kind that has none)
// keeps showing `detail`.

import type { AssertionResult } from "./gateway.ts";

/** Every detail code the Gateway's deterministic assertions emit. */
export const ASSERTION_DETAIL_CODES = [
	"contains.found",
	"contains.missing",
	"not_contains.absent",
	"not_contains.found",
	"equals.match",
	"equals.mismatch",
	"starts_with.match",
	"starts_with.mismatch",
	"regex.matched",
	"regex.no_match",
	"regex.invalid",
	"similarity.score",
	"similarity.too_long",
	"json.valid",
	"json.invalid",
] as const;

export type AssertionDetailCode = (typeof ASSERTION_DETAIL_CODES)[number];

/** An assertion result as the Gateway now sends it, codes included. */
export interface CodedAssertionResult extends AssertionResult {
	/** Stable detail code; absent on results that only have `detail`. */
	code?: string;
	/** Arguments for `code`'s message (`value`, `pattern`, `score`, …). */
	values?: Record<string, unknown>;
}

/** A known detail code with its scalar arguments. */
export interface AssertionDetail {
	code: AssertionDetailCode;
	/** The verdict was negated (`not: true`); the code describes the raw check. */
	negated: boolean;
	values: Record<string, number | string>;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ASSERTION_DETAIL_CODES);

function isDetailCode(code: unknown): code is AssertionDetailCode {
	return typeof code === "string" && KNOWN_CODES.has(code);
}

/**
 * Read the detail code and its scalar arguments from an assertion result, or
 * `null` when the result has no code this client knows (render `detail`).
 */
export function readAssertionDetail(
	result: CodedAssertionResult
): AssertionDetail | null {
	if (!isDetailCode(result.code)) {
		return null;
	}
	const values: Record<string, number | string> = {};
	let negated = false;
	for (const [key, value] of Object.entries(result.values ?? {})) {
		if (key === "negated") {
			negated = value === true;
		} else if (typeof value === "string") {
			values[key] = value;
		} else if (typeof value === "number" && Number.isFinite(value)) {
			values[key] = value;
		}
	}
	return { code: result.code, negated, values };
}
