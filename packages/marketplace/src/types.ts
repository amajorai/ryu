// packages/marketplace/src/types.ts
//
// Canonical money-layer types shared by BOTH the desktop and the web store
// surfaces. These were duplicated verbatim in apps/desktop/src/lib/api/{marketplace,
// seller}.ts and apps/web/src/lib/marketplace-api.ts; the shared store components
// (licenses / sell / purchase / ratings) now type against these so one edit
// updates both surfaces.
//
// The two surfaces still own their own *transport* (desktop carries a Better-Auth
// bearer + opens Stripe URLs through Tauri; web uses the session cookie + a plain
// navigation). Those differences live behind the MarketplaceHost seam (./host);
// the data SHAPES below are identical on both and belong here.

/** The four catalog kinds the money layer covers, matching the server's kind. */
export type MarketplaceKind = "plugin" | "skill" | "model" | "mcp";

/** Purchase/license lifecycle, mirroring the server's LicenseStatus. */
export type LicenseStatus = "active" | "refunded" | "disputed";

/** One owned license, enriched with the item's display name (#492). */
export interface OwnedLicense {
	buyerOrgId: string;
	buyerUserId: string;
	currency: string;
	id: string;
	itemId: string;
	itemKind: MarketplaceKind;
	itemName: string | null;
	itemVersion: string;
	platformFeeMinor: number;
	priceMinor: number;
	purchasedAt: string;
	status: LicenseStatus;
	stripePaymentIntentId: string | null;
}

/** Onboarding lifecycle, mirroring the server's SellerOnboardingStatus. */
export type SellerOnboardingStatus =
	| "none"
	| "pending"
	| "active"
	| "restricted";

/** The stored seller state for the caller's active org. */
export interface SellerStatus {
	onboardingStatus: SellerOnboardingStatus;
	payoutsEnabled: boolean;
	stripeConnectAccountId: string | null;
}

/** The result of starting a purchase: a Stripe URL to open, or already-owned. */
export interface PurchaseResult {
	/** True when the org already held an active license (no new charge). */
	alreadyLicensed: boolean;
	/** Hosted Stripe Checkout URL to open, or "" when alreadyLicensed. */
	url: string;
}

/**
 * A classified degrade-cleanly error the store surfaces read to render a tailored
 * message. Both surfaces' error classes (desktop MarketplaceError/SellerError, web
 * MarketplaceError) structurally satisfy this — the components only ever read
 * `.kind` (e.g. "no_org", "stripe") and `.message`.
 */
export interface MarketplaceHostError {
	readonly kind: string;
	readonly message: string;
}

/** The minimal identity of an item whose detail dialog is being opened. */
export interface MarketplaceDetailTarget {
	iconUrl: string | null;
	id: string;
	kind: MarketplaceKind;
	name: string;
}

/** Format a minor-unit (cents) amount as a localized currency string. */
export function formatPrice(amountMinor: number, currency = "usd"): string {
	return (amountMinor / 100).toLocaleString(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}
