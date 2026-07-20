// packages/marketplace/src/use-marketplace-purchase.ts
//
// The reusable marketplace purchase flow, shared by the inline "From the
// Marketplace" strips (one per catalog section). Owns the transient buying state,
// the Stripe checkout hand-off, and the detail-dialog open state. All surface
// specifics — the licenses hook, the purchase call, and how to open the Stripe URL
// — come from the injected MarketplaceHost.

import { useCallback, useState } from "react";
import { sileo } from "sileo";
import { useMarketplaceHost } from "./host.tsx";
import type { MarketplaceDetailTarget, MarketplaceKind } from "./types.ts";

export type { MarketplaceDetailTarget };

export interface UseMarketplacePurchaseResult {
	buy: (card: { id: string; kind: MarketplaceKind }) => Promise<void>;
	/** id of the item whose checkout is currently being started, or null. */
	buying: string | null;
	closeDetail: () => void;
	detail: MarketplaceDetailTarget | null;
	/** Whether the org owns this (kind, id). */
	isLicensed: (kind: MarketplaceKind, id: string) => boolean;
	openDetail: (target: MarketplaceDetailTarget) => void;
}

export function useMarketplacePurchase(): UseMarketplacePurchaseResult {
	const { useLicenses, startPurchase, openExternal } = useMarketplaceHost();
	const { isLicensed, refresh: refreshLicenses } = useLicenses();
	const [buying, setBuying] = useState<string | null>(null);
	const [detail, setDetail] = useState<MarketplaceDetailTarget | null>(null);

	const buy = useCallback(
		async (card: { id: string; kind: MarketplaceKind }) => {
			setBuying(card.id);
			try {
				const result = await startPurchase({ kind: card.kind, id: card.id });
				if (result.alreadyLicensed) {
					sileo.success({ title: "You already own this item." });
					await refreshLicenses();
					return;
				}
				if (!result.url) {
					sileo.error({ title: "Could not start checkout." });
					return;
				}
				await openExternal(result.url);
				sileo.success({
					title: "Opening checkout…",
					description:
						"Complete payment in your browser. Your license appears here once it clears.",
				});
			} catch (e) {
				const message =
					e instanceof Error ? e.message : "Could not start checkout.";
				sileo.error({ title: message });
			} finally {
				setBuying(null);
			}
		},
		[refreshLicenses, startPurchase, openExternal]
	);

	const openDetail = useCallback(
		(target: MarketplaceDetailTarget) => setDetail(target),
		[]
	);
	const closeDetail = useCallback(() => setDetail(null), []);

	return { buying, buy, isLicensed, detail, openDetail, closeDetail };
}
