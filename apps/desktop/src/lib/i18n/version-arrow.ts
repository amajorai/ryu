// apps/desktop/src/lib/i18n/version-arrow.ts
//
// "A → B" lines as whole catalog messages. Two values glued by an arrow read
// backwards in Arabic: U+2192 does not mirror, and between two numbers the
// bidi algorithm reorders "1.2 → 1.3" into what looks like a downgrade. The
// catalog owns the arrow (Arabic flips it to "←"), and each value is wrapped in
// a first-strong isolate so version numbers and Latin names keep their own
// order inside a right-to-left line.

import type { LiteralMessage } from "@ryu/i18n/react";

const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/** `text` as a bidi isolate, so it cannot reorder with its neighbours. */
export function isolateBidi(text: string): string {
	return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

/** An upgrade from one version to another ("1.2.0 → 1.3.0"). */
export function versionArrow(
	from: string,
	to: string,
	tl: LiteralMessage
): string {
	return tl("{from} → {to}", { from: isolateBidi(from), to: isolateBidi(to) });
}

/** A toolkit now served by a provider ("Web search → Brave"). */
export function providerArrow(
	toolkit: string,
	provider: string,
	tl: LiteralMessage
): string {
	return tl("{toolkit} → {provider}", {
		provider: isolateBidi(provider),
		toolkit: isolateBidi(toolkit),
	});
}
