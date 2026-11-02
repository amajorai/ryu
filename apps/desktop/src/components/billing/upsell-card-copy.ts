// apps/desktop/src/components/billing/upsell-card-copy.ts
//
// Localized copy for the soft upsell cards. The control plane picks WHICH cards
// to show (`selectUpsellCards`) and sends each card's stable id, lever, metric
// and value; the sentence is built here, in the viewer's locale, so the plural
// and the number formatting follow the app language instead of the server's.
//
// The server still sends an English `headline` / `subtext` for older clients.
// Cards this client does not know (the dormant V2 friction and desire levers,
// or a future metric) fall back to those English strings.

import type { UpsellCard } from "@ryu/auth/lib/upsell";
import type { LiteralMessage } from "@ryu/i18n/react";

/** The two visible lines of one upsell card. */
export interface UpsellCardCopy {
	readonly headline: string;
	readonly subtext: string;
}

/** Resolve a card's visible copy in the active locale. */
export function upsellCardCopy(
	card: UpsellCard,
	tl: LiteralMessage
): UpsellCardCopy {
	const count = card.value;
	if (card.lever !== "investment") {
		return { headline: card.headline, subtext: card.subtext };
	}
	switch (card.metric) {
		case "conversations":
			return {
				headline: tl(
					"You've started {count, plural, one {# conversation} other {# conversations}}",
					{ count }
				),
				subtext: tl("All that context lives in Ryu — keep it working for you."),
			};
		case "agent-time":
			return {
				headline: tl(
					"Your agents have worked {count, plural, one {# hour} other {# hours}} for you",
					{ count }
				),
				subtext: tl("Keep managed AI running with a plan and usage credits."),
			};
		case "requests":
			return {
				headline: tl(
					"You've made {count, plural, one {# request} other {# requests}}",
					{ count }
				),
				subtext: tl(
					"You're getting real work done — keep the momentum on Pro."
				),
			};
		default:
			return { headline: card.headline, subtext: card.subtext };
	}
}
