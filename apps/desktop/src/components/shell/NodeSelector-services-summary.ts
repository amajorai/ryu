import { formatList } from "@ryu/i18n";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";

/**
 * The Services row's one line: what is stopped, in the reader's list pattern
 * ("Core and Network stopped", ja "Core、ネットワーク"). Each name goes through
 * the catalog ("Network" translates; Core, Gateway, Shadow and Island stay
 * product names), and the count lets each language agree its verb.
 */
export function servicesSummaryLine(
	tl: LiteralMessage,
	loading: boolean,
	stopped: readonly string[]
): string {
	if (loading) {
		return tl("Checking…");
	}
	if (stopped.length === 0) {
		return tl("All running");
	}
	return tl(
		"{count, plural, one {{services} stopped} other {{services} stopped}}",
		{
			count: stopped.length,
			services: formatList(stopped.map((label) => tl(label))),
		}
	);
}

/** `servicesSummaryLine` in the UI language. */
export function useServicesSummary(
	loading: boolean,
	stopped: readonly string[]
): string {
	return servicesSummaryLine(useLiteralMessages(), loading, stopped);
}
