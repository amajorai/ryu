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
import type {
	MarketplaceDetailTarget,
	MarketplaceKind,
	PurchaseResult,
} from "./types.ts";

export type { MarketplaceDetailTarget };

/** The next step a `buy()` should take, derived from a {@link PurchaseResult}. */
export type PurchaseAction =
	| { kind: "owned" }
	| { kind: "checkout"; url: string }
	| { kind: "error" };

/**
 * Classify a purchase result into the action `buy()` performs. The
 * `alreadyLicensed` check MUST come first: an already-owned result carries an
 * empty `url` (see {@link PurchaseResult}), so testing `url` first would
 * misroute an owned item into the error branch.
 */
export function purchaseAction(result: PurchaseResult): PurchaseAction {
	if (result.alreadyLicensed) {
		return { kind: "owned" };
	}
	if (!result.url) {
		return { kind: "error" };
	}
	return { kind: "checkout", url: result.url };
}

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
				const action = purchaseAction(result);
				if (action.kind === "owned") {
					sileo.success({ title: "You already own this item." });
					await refreshLicenses();
					return;
				}
				if (action.kind === "error") {
					sileo.error({ title: "Could not start checkout." });
					return;
				}
				await openExternal(action.url);
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
