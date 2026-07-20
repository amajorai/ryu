// apps/desktop/src/lib/api/marketplace-view.ts
//
// Presentational adapters for the marketplace money layer. Kept out of the React
// components so both the Account section and the inline "From the Marketplace"
// strips (in each catalog section) map a control-plane `MarketplaceCard` to the
// block's money-logic-free `MarketplaceCardData` the same way.

import type { MarketplaceCardData } from "@ryu/blocks/desktop/marketplace";
import {
	formatPrice,
	type MarketplaceCard,
	type MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";

/** The marketplace kinds, in the order the browse filter shows them. */
export const MARKETPLACE_KINDS: { value: MarketplaceKind; label: string }[] = [
	{ value: "skill", label: "Skills" },
	{ value: "plugin", label: "Plugins" },
	{ value: "mcp", label: "Tools" },
	{ value: "model", label: "Models" },
];

/**
 * Map a control-plane catalog card to the block's presentational shape,
 * resolving the price string and ownership here so the block stays
 * money-logic-free.
 */
export function toCardData(
	card: MarketplaceCard,
	owned: boolean,
	buying: boolean
): MarketplaceCardData {
	const priceLabel = card.pricing
		? `${formatPrice(card.pricing.amountMinor, card.pricing.currency)}${
				card.pricing.model === "subscription" ? "/mo" : ""
			}`
		: null;
	return {
		id: card.id,
		kind: card.kind,
		name: card.name,
		author: card.author,
		description: card.description,
		version: card.version,
		verification: card.verification,
		iconUrl: card.iconUrl,
		category: card.category,
		ratingAverage: card.ratingAverage,
		ratingCount: card.ratingCount,
		priceLabel,
		owned,
		buying,
	};
}
