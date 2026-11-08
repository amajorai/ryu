import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { eventOutcome } from "./wiki-model-pages.ts";

/**
 * Wiki run outcomes as whole sentences. `eventOutcome` returns a stable key
 * ("scheduled", "failed", "succeeded" or "ran"); each phrase that shows it
 * selects the word inside one catalog message, so a translation never
 * receives the English word as an argument.
 */

/** "(scheduled run, failed)" on the revision history line. */
export function scheduledRunOutcome(
	event: InterfaceEvent,
	tl: LiteralMessage
): string {
	return tl(
		"(scheduled run, {outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}})",
		{ outcome: eventOutcome(event) }
	);
}

/** "(failed)" after a run on the main page. */
export function bracketedRunOutcome(
	event: InterfaceEvent,
	tl: LiteralMessage
): string {
	return tl(
		"({outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}})",
		{ outcome: eventOutcome(event) }
	);
}

/** "failed 3h ago" in a run list; `ago` is the already formatted age. */
export function runOutcomeAgo(
	event: InterfaceEvent,
	ago: string,
	tl: LiteralMessage
): string {
	return tl(
		"{outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}} {ago}",
		{ ago, outcome: eventOutcome(event) }
	);
}
