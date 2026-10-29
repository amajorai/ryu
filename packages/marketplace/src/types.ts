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

import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";

/** The catalog kinds the money layer covers, matching the server's kind.
 *  `agent` is a user-published Agent Template — a configuration rather than
 *  executable code. `knowledge` is a published knowledge bundle (an OKF
 *  concept collection), also content rather than code. */
export type MarketplaceKind =
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

/** Purchase/license lifecycle, mirroring the server's LicenseStatus. */
export type LicenseStatus = "active" | "expired" | "refunded" | "disputed";

/** One owned license, enriched with the item's display name (#492). */
export interface OwnedLicense {
	buyerOrgId: string;
	buyerUserId: string;
	/**
	 * A subscription license set to end at its period end instead of renewing.
	 * Absent from servers that predate renewal management.
	 */
	cancelAtPeriodEnd?: boolean;
	currency: string;
	entitlementUntil: string | null;
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
	stripeSubscriptionId: string | null;
}

/** Onboarding lifecycle, mirroring the server's SellerOnboardingStatus. */
export type SellerOnboardingStatus =
	| "none"
	| "pending"
	| "active"
	| "restricted";

/** Stripe's identity signal; it is not Ryu staff endorsement. */
export type SellerIdentityStatus =
	| "none"
	| "pending"
	| "verified"
	| "restricted";

/** The stored seller state for the caller's active org. */
export interface SellerStatus {
	onboardingStatus: SellerOnboardingStatus;
	payoutsEnabled: boolean;
	stripeConnectAccountId: string | null;
	stripeIdentityStatus: SellerIdentityStatus;
}

/** The result of starting a purchase: a Stripe URL to open, or already-owned. */
export interface PurchaseResult {
	/** True when the org already held an active license (no new charge). */
	alreadyLicensed: boolean;
	/** Checkout URL (Ryu's checkout page, or Stripe-hosted Checkout when first-party checkout is off) to open, or "" when alreadyLicensed. */
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
	return formatMinorCurrency(amountMinor, currency);
}

/** The pricing fields {@link formatPricingLabel} reads; every surface's pricing view satisfies it. */
export interface MarketplacePriceTerms {
	amountMinor: number;
	currency: string;
	interval: "month" | "year";
	maxUpdates: number | null;
	model: "one_time" | "subscription" | "bounded_updates";
}

/** Add the billing or included-update term to a marketplace price. */
export function formatPricingLabel(pricing: MarketplacePriceTerms): string {
	const suffix =
		pricing.model === "subscription"
			? `/${pricing.interval === "year" ? "yr" : "mo"}`
			: pricing.model === "bounded_updates"
				? ` · ${pricing.maxUpdates ?? "limited"} updates`
				: "";
	return `${formatPrice(pricing.amountMinor, pricing.currency)}${suffix}`;
}
