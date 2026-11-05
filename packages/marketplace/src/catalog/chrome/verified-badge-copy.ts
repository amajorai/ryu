// Translated label and tooltip per publisher trust level.
//
// `@ryuhq/protocol/publisher-trust` keeps English labels for non-UI callers; the
// badge renders these instead so every word is a catalog key. Each sentence is a
// literal `tl()` call (never `tl(variable)`) so the extractor collects it.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";

export interface PublisherTrustCopy {
	/** Accessible name and popover title. */
	label: string;
	/** Popover description and the fallback verification method. */
	tooltip: string;
}

export function publisherTrustCopy(
	tl: LiteralMessage,
	level: PublisherTrustLevel
): PublisherTrustCopy {
	switch (level) {
		case "gold":
			return {
				label: tl("Verified business"),
				tooltip: tl(
					"Ryu staff verified this Business organization, its Stripe identity, and its domain."
				),
			};
		case "blue":
			return {
				label: tl("Verified paid organization"),
				tooltip: tl(
					"This organization has an active paid Ryu plan and verified its identity through Stripe or a domain it owns. Ryu staff has not reviewed it."
				),
			};
		case "dotted":
			return {
				label: tl("Unverified publisher"),
				tooltip: tl(
					"This is not a verified publisher. Review the health signals before installing."
				),
			};
		default:
			return assertNever(level);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled publisher trust level: ${String(value)}`);
}
