import type { MarketplaceKind } from "../types.ts";

/** Public, content-free usage totals shown on Marketplace listings. */
export interface MarketplaceCommunityStats {
	downloads: number;
	instances: number;
	runs: number;
}

/** One member of a one-click Marketplace bundle. */
export interface MarketplaceBundleMember {
	id: string;
	kind: Exclude<MarketplaceKind, "bundle">;
	name: string | null;
	required: boolean;
	source: string | null;
}
