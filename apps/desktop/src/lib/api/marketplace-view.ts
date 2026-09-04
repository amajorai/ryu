// apps/desktop/src/lib/api/marketplace-view.ts
//
// Presentational adapters for the marketplace money layer. Kept out of the React
// components so both the Account section and the inline "From the Marketplace"
// strips (in each catalog section) map a control-plane `MarketplaceCard` to the
// block's money-logic-free `MarketplaceCardData` the same way.

import type { MarketplaceCardData } from "@ryu/blocks/desktop/marketplace";
import {
	formatPricingLabel,
	type MarketplaceCard,
} from "@/src/lib/api/marketplace.ts";

/**
 * Map a control-plane catalog card to the block's presentational shape,
 * resolving the price string and ownership here so the block stays
 * money-logic-free.
 */
export function toCardData(
	card: MarketplaceCard,
	owned: boolean,
	buying: boolean,
	options: {
		active?: boolean;
		installed?: boolean;
		installing?: boolean;
		onInstall?: () => void;
	} = {}
): MarketplaceCardData {
	const priceLabel = card.pricing ? formatPricingLabel(card.pricing) : null;
	return {
		id: card.id,
		kind: card.kind,
		name: card.name,
		author: card.author,
		description: card.description,
		languagePack: card.languagePack,
		active: options.active,
		installed: options.installed,
		installing: options.installing,
		onInstall: options.onInstall,
		version: card.version,
		verification: card.verification,
		iconUrl: card.iconUrl,
		category: card.category,
		ratingAverage: card.ratingAverage,
		ratingCount: card.ratingCount,
		priceLabel,
		owned,
		buying,
		membershipIncluded: card.membershipIncluded,
	};
}
