// packages/marketplace/src/creators/creator-types.ts
//
// Wire shapes for the Marketplace Creators tab, shared by web and desktop. A
// creator is a publishing organization with at least one live public listing;
// the control plane owns the directory (`GET /api/marketplace/creators`) and
// each profile (`GET /api/marketplace/creators/:handle`). Surfaces own only the
// transport, injected through `MarketplaceHost.creators`.

import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import type { ReactNode } from "react";
import type { MarketplaceCommunityStats } from "../catalog/bundle-types.ts";
import type { MarketplaceKind } from "../types.ts";

export const MARKETPLACE_CREATOR_SORTS = [
	{ value: "popular", label: "Most followed" },
	{ value: "listings", label: "Most listings" },
	{ value: "rating", label: "Top rated" },
	{ value: "newest", label: "Newest" },
	{ value: "name", label: "Name" },
] as const;

export type MarketplaceCreatorSort =
	(typeof MARKETPLACE_CREATOR_SORTS)[number]["value"];

/** One creator card, or the header of a creator profile. */
export interface MarketplaceCreator {
	bio: string | null;
	featuredCount: number;
	firstPublishedAt: string | null;
	followerCount: number;
	githubHandle: string | null;
	id: string;
	kinds: string[];
	lastPublishedAt: string | null;
	listingCount: number;
	logo: string | null;
	name: string;
	publisherTrust: PublisherTrustLevel | null;
	publisherVerification: VerificationDetails | null;
	ratingAverage: number;
	ratingCount: number;
	slug: string | null;
	website: string | null;
	xHandle: string | null;
}

/** The listing fields a creator profile renders. The control plane sends the
 *  full catalog card; surfaces map only what this view reads. */
export interface MarketplaceCreatorListing {
	communityStats: MarketplaceCommunityStats | null;
	description: string | null;
	featured: boolean;
	iconUrl: string | null;
	id: string;
	kind: MarketplaceKind;
	name: string;
	/** Short price label ("Free", "$9", "$4/mo"), formatted by the surface. */
	priceLabel: string | null;
	ratingAverage: number;
	ratingCount: number;
}

export interface MarketplaceCreatorProfile {
	creator: MarketplaceCreator;
	listings: MarketplaceCreatorListing[];
}

/** The public creator profile an organization edits for itself. */
export interface MarketplaceCreatorProfileFields {
	bio: string | null;
	githubHandle: string | null;
	website: string | null;
	xHandle: string | null;
}

/** The active organization's own creator profile, as its editor loads it. */
export interface MarketplaceOwnCreatorProfile {
	name: string;
	organizationId: string;
	profile: MarketplaceCreatorProfileFields;
	slug: string | null;
}

/** The creator directory and profile reads, injected by each surface. */
export interface MarketplaceCreatorsService {
	/** One creator's profile and listings; null when the handle is unknown. */
	get: (
		handle: string,
		signal?: AbortSignal
	) => Promise<MarketplaceCreatorProfile | null>;
	list: (input: {
		query: string;
		signal?: AbortSignal;
		sort: MarketplaceCreatorSort;
	}) => Promise<MarketplaceCreator[]>;
	/** A surface link for a listing tile, when the surface routes by URL. */
	listingHref?: (listing: MarketplaceCreatorListing) => string | null;
	/** Open a listing in the surface's own detail view. */
	openListing?: (listing: MarketplaceCreatorListing) => void;
	/** Read and write the active organization's creator profile. Omitted by a
	 *  surface that cannot edit it; the Sell tab then hides the editor. */
	ownProfile?: {
		load: () => Promise<MarketplaceOwnCreatorProfile>;
		save: (
			fields: MarketplaceCreatorProfileFields,
			organizationId?: string
		) => Promise<MarketplaceCreatorProfileFields>;
	};
	/** The surface's follow control, when it has a signed-in follow model. */
	renderFollow?: (creator: MarketplaceCreator) => ReactNode;
}
