import type { ReactNode } from "react";

/** Mirrors the control plane's `MarketplaceKind`. `agent` is a user-published
 *  agent definition — a configuration, not code. */
export type MarketplaceItemKind =
	| "app"
	| "plugin"
	| "skill"
	| "model"
	| "mcp"
	| "knowledge"
	| "agent"
	| "stack_template"
	| "workflow"
	| "theme"
	| "language_pack"
	| "space"
	| "profile"
	| "output_style"
	| "bundle";

export type MarketplaceVerification =
	| "verified"
	| "unsigned"
	| "invalid"
	| "unknown";

export interface MarketplaceCommunityStats {
	downloads: number;
	instances: number;
	runs: number;
}

/** Presentational card shape. Mirrors the app's `MarketplaceCard` but pre-resolves
 *  the price string so this layer carries no money-formatting logic. `priceLabel`
 *  is null for free items. A price is commerce metadata, not a runtime access
 *  decision; every catalog item keeps the same add/open affordance. */
export interface MarketplaceCardData {
	/** True when the installed language pack is the selected runtime pack. */
	active?: boolean;
	author: string | null;
	bundleMemberCount?: number;
	/** True while a checkout for this card is in flight. */
	buying?: boolean;
	/** Store-taxonomy category (carried for callers; not part of the card chrome). */
	category?: string | null;
	communityStats?: MarketplaceCommunityStats;
	description: string | null;
	/** Resolvable logo URL; falls back to the item's initial when null/absent. */
	iconUrl?: string | null;
	id: string;
	/** True when a language pack is present on the active node. */
	installed?: boolean;
	/** True while a language pack install/enable request is running. */
	installing?: boolean;
	kind: MarketplaceItemKind;
	languagePack?: {
		baseLocale: string;
		direction: "ltr" | "rtl";
		locale: string;
		messageCount: number;
	} | null;
	/** Like control supplied by the host; kept as a node to avoid importing the host store. */
	like?: ReactNode;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	name: string;
	/** Install or enable a language pack. */
	onInstall?: () => void;
	/** Whether the active org already owns this paid item. */
	owned: boolean;
	/** Pre-formatted price (e.g. "$4" or "$9/mo"), or null when the item is free. */
	priceLabel: string | null;
	/** Mean review rating; the compact star row renders when `ratingCount > 0`. */
	ratingAverage?: number;
	/** Number of reviews behind the average. */
	ratingCount?: number;
	verification: MarketplaceVerification;
	version: string;
}

export interface MarketplaceKindOption {
	label: string;
	value: MarketplaceItemKind;
}
