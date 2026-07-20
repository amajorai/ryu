// apps/desktop/src/components/marketplace/useMarketplacePurchase.ts
//
// Moved to the shared @ryu/marketplace package. This re-export preserves the
// existing desktop import path (MarketplaceStrip). The Buy flow's surface services
// (licenses hook, purchase call, openExternal) come from <DesktopMarketplaceHost>.

export {
	type MarketplaceDetailTarget,
	type UseMarketplacePurchaseResult,
	useMarketplacePurchase,
} from "@ryu/marketplace/use-marketplace-purchase";
