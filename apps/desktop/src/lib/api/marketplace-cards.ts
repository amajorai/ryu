// apps/desktop/src/lib/api/marketplace-cards.ts
//
// Catalog card types and wire-to-card normalization.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { LanguagePackSummary } from "@ryu/i18n/core";
import type { MarketplaceCommunityStats } from "@ryu/marketplace/catalog/bundle-types";
import type { MarketplaceKind } from "@ryu/marketplace/types";
import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import {
	type PublisherTrustLevel,
	type PublisherTrustSource,
	publisherTrustFromOrgFlag,
} from "@ryuhq/protocol/publisher-trust";
import {
	type MarketplaceDocument,
	marketplaceNumberField,
} from "./marketplace-wire-values.ts";

/** Pricing model for a paid item. Free items carry no pricing at all. */
export type PricingModel = "one_time" | "subscription" | "bounded_updates";

/** The pricing view the server surfaces for a paid item (null ⇒ free). */
export interface PricingView {
	amountMinor: number;
	currency: string;
	interval: "month" | "year";
	maxUpdates: number | null;
	model: PricingModel;
	platformFeeBps: number;
	sellerOrgId: string;
}

/**
 * Manifest signature/provenance status for an item (#450). This is the
 * verification verdict the Gateway issues over a manifest's signature, surfaced
 * for display so the Store can flag unsigned or tampered items before install:
 *   - "verified": a valid Gateway/seller signature was checked and passed.
 *   - "unsigned": no signature is present (a seed/legacy item; install allowed
 *     but provenance is unproven).
 *   - "invalid":  a signature is present but failed verification (tampered, so
 *     Core refuses to install).
 *   - "unknown":  the server did not report a verification status.
 *
 * NOTE (#450, PARTIAL): the control-plane catalog response does NOT yet emit a
 * per-item verification verdict. Core verifies signatures server-side as an
 * install GATE (apps/core catalog_source verify_manifest_signature: fail-closed
 * on tamper, silently allow unsigned) but never surfaces the result as a field.
 * Until a Core/server `verified` (or `signature`) field is added to the catalog
 * payload, this resolves from the trusted-first-party flag as a best-effort proxy
 * (first-party items are Ryu-published and signed). The display scaffolding below
 * is ready to consume the real field the moment it exists.
 */
export type VerificationStatus =
	| "verified"
	| "unsigned"
	| "invalid"
	| "unknown";

/** A flat marketplace catalog card. `pricing` is null for free items. */
export interface MarketplaceCard {
	artifactKinds: string[];
	author: string | null;
	bundleMemberCount: number;
	/** Store-taxonomy category label (e.g. "Productivity"), or null. */
	category: string | null;
	communityStats: MarketplaceCommunityStats;
	description: string | null;
	downloadUrl: string | null;
	firstParty: boolean;
	githubSource: MarketplaceDocument | null;
	/** Resolvable logo URL (https / data:), or null when the item has no icon. */
	iconUrl: string | null;
	id: string;
	installedVersion: string | null;
	installSource: string | null;
	kind: MarketplaceKind;
	languagePack: LanguagePackSummary | null;
	latestVersion: string | null;
	/** Public like total and current viewer state from the catalog read. */
	likeCount: number;
	likedByMe: boolean;
	/** True when the publisher's supported paid offer is covered by A Major Pass. */
	membershipIncluded: boolean;
	name: string;
	orgVerified: boolean;
	orgVerifiedTier: string | null;
	packageChecksum: string | null;
	packageKind: string | null;
	packageSecurity: MarketplaceDocument | null;
	packageSource: MarketplaceDocument | string | null;
	pricing: PricingView | null;
	publisherTrust: PublisherTrustLevel;
	publisherTrustSource: PublisherTrustSource;
	publisherVerification: VerificationDetails | null;
	/** Mean of all published review ratings (0 when there are no reviews). */
	ratingAverage: number;
	/** Total count of published reviews. */
	ratingCount: number;
	requirements: MarketplaceDocument;
	scopes: string[];
	targets: string[];
	updateAvailable: boolean;
	updatePreview: MarketplaceDocument | null;
	/** Manifest signature verdict for display (#450). See {@link VerificationStatus}. */
	verification: VerificationStatus;
	version: string;
}

/** Wire shape of a catalog card before client normalization. Forward-compatible:
 *  `verified`/`signature` are optional and only emitted once Core/server adds them. */
export interface MarketplaceCardWire
	extends Omit<
		MarketplaceCard,
		| "verification"
		| "bundleMemberCount"
		| "communityStats"
		| "likeCount"
		| "likedByMe"
		| "orgVerified"
		| "orgVerifiedTier"
		| "membershipIncluded"
		| "publisherTrust"
		| "publisherTrustSource"
		| "publisherVerification"
		| "artifactKinds"
		| "packageKind"
		| "packageSource"
		| "packageChecksum"
		| "packageSecurity"
		| "githubSource"
		| "languagePack"
		| "downloadUrl"
		| "targets"
		| "scopes"
		| "requirements"
		| "installedVersion"
		| "latestVersion"
		| "updateAvailable"
		| "updatePreview"
	> {
	artifactKinds?: string[] | null;
	bundleMemberCount?: number | null;
	communityStats?: Partial<MarketplaceCommunityStats> | null;
	downloadUrl?: string | null;
	githubSource?: MarketplaceDocument | null;
	installedVersion?: string | null;
	languagePack?: LanguagePackSummary | null;
	latestVersion?: string | null;
	likeCount?: number | null;
	likedByMe?: boolean | null;
	membershipIncluded?: boolean | null;
	orgVerified?: boolean | null;
	orgVerifiedTier?: string | null;
	packageChecksum?: string | null;
	packageKind?: string | null;
	packageSecurity?: MarketplaceDocument | null;
	packageSource?: MarketplaceDocument | string | null;
	publisherTrust?: PublisherTrustLevel | null;
	publisherTrustSource?: PublisherTrustSource | null;
	publisherVerification?: VerificationDetails | null;
	requirements?: MarketplaceDocument | null;
	scopes?: string[] | null;
	/** Future Core/server field: presence implies signed (verdict still preferred). */
	signature?: string | null;
	targets?: string[] | null;
	updateAvailable?: boolean | null;
	updatePreview?: MarketplaceDocument | null;
	/** Future Core/server field: the manifest verification verdict, if reported. */
	verified?: VerificationStatus | boolean | null;
}

/**
 * Resolve the verification verdict for a card. Prefers an explicit server-reported
 * `verified` field (the #450 target) and degrades gracefully when it is absent: a
 * present signature ⇒ "verified" (the server only relays signatures it accepted),
 * a trusted first-party item ⇒ "verified" (Ryu-published and signed), otherwise
 * "unknown" (provenance not reported, so do NOT claim "verified").
 */
function resolveVerification(card: MarketplaceCardWire): VerificationStatus {
	if (
		card.verified === "verified" ||
		card.verified === "unsigned" ||
		card.verified === "invalid" ||
		card.verified === "unknown"
	) {
		return card.verified;
	}
	if (card.verified === true) {
		return "verified";
	}
	if (card.verified === false) {
		return "invalid";
	}
	if (card.signature) {
		return "verified";
	}
	if (card.firstParty) {
		return "verified";
	}
	return "unknown";
}

export function toMarketplaceCard(card: MarketplaceCardWire): MarketplaceCard {
	const { verified: _verified, signature: _signature, ...rest } = card;
	return {
		...rest,
		artifactKinds: rest.artifactKinds ?? [],
		bundleMemberCount: marketplaceNumberField(card.bundleMemberCount) ?? 0,
		iconUrl: rest.iconUrl ?? null,
		category: rest.category ?? null,
		communityStats: {
			downloads: marketplaceNumberField(card.communityStats?.downloads) ?? 0,
			instances: marketplaceNumberField(card.communityStats?.instances) ?? 0,
			runs: marketplaceNumberField(card.communityStats?.runs) ?? 0,
		},
		likeCount: marketplaceNumberField(card.likeCount) ?? 0,
		likedByMe: card.likedByMe === true,
		orgVerified: Boolean(card.orgVerified),
		orgVerifiedTier: card.orgVerifiedTier ?? null,
		publisherTrust:
			card.publisherTrust ??
			publisherTrustFromOrgFlag({
				firstParty: card.firstParty,
				orgVerified: card.orgVerified,
			}).level,
		publisherTrustSource:
			card.publisherTrustSource ??
			publisherTrustFromOrgFlag({
				firstParty: card.firstParty,
				orgVerified: card.orgVerified,
			}).source,
		publisherVerification: card.publisherVerification ?? null,
		packageKind: rest.packageKind ?? null,
		packageSource: rest.packageSource ?? null,
		packageChecksum: rest.packageChecksum ?? null,
		packageSecurity: rest.packageSecurity ?? null,
		githubSource: rest.githubSource ?? null,
		languagePack: rest.languagePack ?? null,
		downloadUrl: rest.downloadUrl ?? null,
		pricing: rest.pricing
			? {
					...rest.pricing,
					interval: rest.pricing.interval === "year" ? "year" : "month",
				}
			: null,
		targets: rest.targets ?? [],
		scopes: rest.scopes ?? [],
		requirements: rest.requirements ?? {},
		installedVersion: rest.installedVersion ?? null,
		latestVersion: rest.latestVersion ?? null,
		membershipIncluded: Boolean(card.membershipIncluded),
		updateAvailable: Boolean(rest.updateAvailable),
		updatePreview: rest.updatePreview ?? null,
		ratingAverage: rest.ratingAverage ?? 0,
		ratingCount: rest.ratingCount ?? 0,
		verification: resolveVerification(card),
	};
}
