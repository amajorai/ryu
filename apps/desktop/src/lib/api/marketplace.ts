// apps/desktop/src/lib/api/marketplace.ts
//
// Typed client for the Ryu Marketplace money layer (monetization #492, spec §3).
// Browse paid items, start a Stripe Connect purchase, and list owned licenses.
//
// Like credits.ts / seller.ts (and unlike the Core-node catalog clients in
// skills.ts / models.ts), this targets the identity/control-plane server (:3000,
// BACKEND_URL), authenticated with the Better-Auth session bearer. Pricing,
// purchases, and licenses are a "what is paid for" concern and live in the
// control plane (packages/api `/api/marketplace`, MongoDB), alongside billing.
//
// IMPORTANT: this is the ONLY place the desktop sees per-item PRICING. The Core
// catalog adapter (browse via Core) deliberately strips pricing, so the buy
// affordances key off this server's catalog, not Core's. A free item never
// carries a `pricing` sub-doc here, so it renders with no price/buy affordance by
// construction.
//
//   GET  /api/marketplace/catalog?kind=&query=  -> live items + pricing (public)
//   POST /api/marketplace/purchase              -> a Stripe Checkout URL (Connect)
//   GET  /api/marketplace/licenses              -> the active org's owned items
//
// Money amounts are integer minor units (cents); `formatPrice`
// (@ryu/marketplace/types) converts for display. The purchase opens a hosted
// Stripe URL externally and the license is granted asynchronously by the server
// webhook, so the UI re-fetches licenses on window focus (mirrors
// useCreditsWallet).
//
// The implementation is split by responsibility into sibling
// `marketplace-<topic>.ts` modules; this file only re-exports them so every
// existing import path (and every `mock.module` of this path) keeps working.

export type {
	LicenseStatus,
	MarketplaceKind,
	OwnedLicense,
} from "@ryu/marketplace/types";
export { formatPricingLabel } from "@ryu/marketplace/types";
export type {
	MarketplaceCard,
	MarketplaceCardWire,
	PricingModel,
	PricingView,
	VerificationStatus,
} from "./marketplace-cards.ts";
export type {
	MarketplaceCatalogPage,
	PurchaseResult,
} from "./marketplace-catalog.ts";
export {
	fetchCatalog,
	fetchCatalogPage,
	fetchFeatured,
	fetchLicenses,
	searchMarketplaceCatalog,
	startPurchase,
} from "./marketplace-catalog.ts";
export type { LikeSnapshot } from "./marketplace-community.ts";
export {
	fetchLikeCounts,
	fetchMarketplaceCreator,
	fetchMarketplaceCreators,
	fetchOwnCreatorProfile,
	likeItem,
	saveOwnCreatorProfile,
	unlikeItem,
} from "./marketplace-community.ts";
export type {
	DetailRunnable,
	DetailSetupStep,
	MarketplaceAgentIdentityMode,
	MarketplaceDetail,
} from "./marketplace-detail.ts";
export {
	fetchDetail,
	marketplaceAgentIdentityMode,
} from "./marketplace-detail.ts";
export type { MarketplaceErrorKind } from "./marketplace-http.ts";
export { MarketplaceError } from "./marketplace-http.ts";
export type {
	MarketplaceMembershipPublisherReport,
	MarketplaceMembershipRevenueCurrency,
	MarketplaceMembershipUsageResult,
} from "./marketplace-membership.ts";
export {
	fetchMarketplaceMembershipPublisherReport,
	hasMarketplaceAuth,
	recordMarketplaceMembershipUsage,
} from "./marketplace-membership.ts";
export type { PortablePackageState } from "./marketplace-portable-packages.ts";
export {
	fetchInstalledPortablePackages,
	installPortablePackage,
	recordMarketplaceUsage,
	setPortablePackageEnabled,
	uninstallPortablePackage,
} from "./marketplace-portable-packages.ts";
export type {
	CreatePrivatePackageShareCodeInput,
	PackageConnectionRequirement,
	PrivatePackageShareCode,
	PrivatePackageSharePreview,
	PrivatePackageShareRedeemResult,
	RedeemedPrivatePackageShareSession,
	ShareCodeAudience,
} from "./marketplace-private-share.ts";
export {
	createPrivatePackageShareCode,
	forgetRedeemedPrivatePackageShareSession,
	formatPrivatePackageShareCode,
	listPrivatePackageShareCodes,
	normalizePrivatePackageShareCode,
	peekRedeemedPrivatePackageShareSession,
	previewPrivatePackageShareCode,
	redeemPrivatePackageShareCode,
	revokePrivatePackageShareCode,
} from "./marketplace-private-share.ts";
export type {
	GithubInstallationResult,
	GithubPublishPricing,
	GithubPublishResult,
	PublishRequest,
	PublishResult,
} from "./marketplace-publish.ts";
export {
	completeGithubInstallation,
	publishGithubPackage,
	publishRunnable,
	uploadListingMedia,
} from "./marketplace-publish.ts";
export type {
	MarketplaceReportView,
	ReportReason,
	ReportSource,
	ReportStatus,
	SubmitReportInput,
	SubmitReportResult,
} from "./marketplace-reports.ts";
export {
	fetchSellerReports,
	resolveReport,
	submitReport,
} from "./marketplace-reports.ts";
export type {
	PostReviewResult,
	Review,
	ReviewsPage,
} from "./marketplace-reviews.ts";
export {
	deleteReview,
	fetchReviews,
	postReview,
} from "./marketplace-reviews.ts";
