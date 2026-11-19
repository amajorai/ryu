// The billing tab's plan sentences that depend on the billing interval. Each
// interval has its own whole sentence ("Billed monthly after trial ends.")
// instead of an interval word spliced into English ("{interval}ly").

import type { LiteralMessage } from "@ryu/i18n/react";

/** The trial footer's billing sentence, or "" for an unknown interval. */
export function trialBillingSentence(
	interval: unknown,
	tl: LiteralMessage
): string {
	if (interval === "month") {
		return tl("Billed monthly after trial ends.");
	}
	if (interval === "year") {
		return tl("Billed annually after trial ends.");
	}
	return "";
}
