// packages/marketplace/src/host.tsx
//
// The host-services seam for the shared store/marketplace UI. Every surface-specific
// dependency the money-layer components need — the license/seller data hooks, the
// purchase action, and how to open an external Stripe URL — is injected here, so the
// components themselves are surface-agnostic and identical on desktop and web.
//
// Desktop provides hooks backed by its Better-Auth bearer + Tauri `openExternal`
// (apps/desktop/src/components/marketplace/host.tsx); web provides hooks backed by
// the session cookie + `window.location` (apps/web/src/components/marketplace/host.tsx).
// The host value MUST be a stable module const on each surface so the hooks it
// carries keep a consistent identity across renders (rules of hooks).

import { createContext, type ReactNode, useContext } from "react";
import type { MarketplaceCreatorsService } from "./creators/creator-types.ts";
import { LikesProvider } from "./likes/likes-provider.tsx";
import type { MarketplaceLikesService } from "./likes/likes-store.ts";
import type {
	MarketplaceDetailTarget,
	MarketplaceHostError,
	MarketplaceKind,
	OwnedLicense,
	PurchaseResult,
	SellerStatus,
} from "./types.ts";

/** What a surface's "my licenses" hook must return for the shared LicensesTab. */
export interface LicensesState {
	authed: boolean;
	error: MarketplaceHostError | null;
	isLicensed: (kind: MarketplaceKind, id: string) => boolean;
	licenses: OwnedLicense[];
	loading: boolean;
	refresh: () => Promise<void> | void;
}

/** What a surface's "seller status" hook must return for the shared SellTab. */
export interface SellerState {
	authed: boolean;
	error: MarketplaceHostError | null;
	loading: boolean;
	/** Begin (or resume) onboarding; resolves to a hosted Stripe URL. */
	onboard: () => Promise<string>;
	onboarding: boolean;
	refresh: () => Promise<void> | void;
	status: SellerStatus | null;
}

/** One row of the seller reports inbox (quality reports on the org's listings). */
export interface SellerReportRow {
	details: string | null;
	id: string;
	itemId: string;
	itemKind: string;
	itemName: string | null;
	reason: string;
	status: string;
}

export interface SellerReportsState {
	authed: boolean;
	error: MarketplaceHostError | null;
	loading: boolean;
	refresh: () => Promise<void> | void;
	reports: SellerReportRow[];
	resolve: (input: {
		id: string;
		note?: string | null;
		status: "resolved" | "dismissed" | "reviewing" | "open";
	}) => Promise<void>;
}

/** Publisher-facing A Major Pass revenue totals, grouped by payout currency. */
export interface MarketplaceMembershipRevenueBucket {
	currency: string;
	failedMinor: number;
	paidMinor: number;
	pendingMinor: number;
	usageCount: number;
}

export interface MarketplaceMembershipReport {
	currencies: MarketplaceMembershipRevenueBucket[];
	eligibleListingCount: number;
}

export interface MarketplaceMembershipState {
	authed: boolean;
	error: MarketplaceHostError | null;
	loading: boolean;
	refresh: () => Promise<void> | void;
	report: MarketplaceMembershipReport | null;
}

/** One user-submitted review as the control plane returns it. */
export interface MarketplaceReview {
	body: string | null;
	createdAt: string;
	id: string;
	/** True when the caller wrote this review — gates the edit/delete affordances. */
	mine?: boolean;
	rating: number;
	title: string | null;
	userName: string | null;
	/** The control plane confirmed an active license — the "Verified purchase" badge. */
	verifiedPurchase: boolean;
}

/** A page of reviews plus the item's denormalized aggregate. */
export interface MarketplaceReviewsPage {
	nextCursor: string | null;
	ratingAverage: number;
	ratingCount: number;
	reviews: MarketplaceReview[];
}

/** The review read/write calls, injected because they live on the CONTROL PLANE
 *  (api.ryuhq.com), not on the Core node the catalog itself is browsed from — the
 *  shared components must not know either address. Omitted by a surface that has no
 *  session at all, which collapses the Reviews tab to its read-only state. */
export interface MarketplaceReviewsService {
	/** Whether a review write can even be attempted (a signed-in session exists). */
	canWrite: () => boolean;
	/** A page of reviews for one item. */
	list: (input: {
		cursor?: string | null;
		id: string;
		kind: MarketplaceKind;
		limit?: number;
	}) => Promise<MarketplaceReviewsPage>;
	/** Optional surface-owned sign-in action for the empty review state. */
	onSignIn?: () => Promise<void> | void;
	/** Create or update the caller's review (upsert — one per user per item). */
	post: (input: {
		body?: string;
		id: string;
		kind: MarketplaceKind;
		rating: number;
		title?: string;
	}) => Promise<{ ratingAverage: number; ratingCount: number }>;
	/** Delete the caller's own review. */
	remove: (input: { id: string; kind: MarketplaceKind }) => Promise<void>;
}

/** The full set of services the shared store UI needs from its host surface. */
export interface MarketplaceHost {
	/** The Creators directory and profiles. Optional: a surface without a
	 *  control-plane binding renders the tab's unavailable state. */
	creators?: MarketplaceCreatorsService;
	/** Optional surface-owned confirmation around card-funded purchases. */
	guardPurchase?: <T>(action: () => Promise<T>) => Promise<T | null>;
	/** The heart on a store card: bulk count reads plus like/unlike, keyed by the
	 *  listing NAMESPACE. Optional for the same reason `reviews` is — a surface
	 *  with no control-plane binding renders no heart rather than a dead one. */
	likes?: MarketplaceLikesService;
	/** Open an external URL (Tauri shell on desktop, navigation on web). */
	openExternal: (url: string) => Promise<void> | void;
	/** Open one owned license's manage view (renewal, period end). Optional: a
	 *  surface without one renders no "Manage" action on subscription rows. */
	openLicense?: (licenseId: string) => Promise<void> | void;
	/** Return to the marketplace catalog from an account empty state. */
	openMarketplace?: () => Promise<void> | void;
	/** Open organization selection from an org-gated empty state. */
	openOrganization?: () => Promise<void> | void;
	/** Open the surface's own seller payouts view (Stripe Connect embedded
	 *  onboarding and payouts). Optional: when absent, the Sell tab mints a
	 *  Stripe-hosted onboarding link through `onboard()` and `openExternal`. */
	openSellerPayouts?: () => Promise<void> | void;
	/** Open the surface's sign-in flow from an auth-gated empty state. */
	openSignIn?: () => Promise<void> | void;
	/** Optional surface-owned confirmation dialog rendered beside the marketplace. */
	purchaseDialog?: ReactNode;
	/** Ratings + user-submitted reviews. Optional: a surface without it renders no
	 *  Reviews tab at all, rather than an empty one that can never be filled. */
	reviews?: MarketplaceReviewsService;
	/** Start a paid-item purchase; resolves to a Stripe URL or already-owned. */
	startPurchase: (input: {
		id: string;
		kind: MarketplaceKind;
	}) => Promise<PurchaseResult>;
	/** The surface's owned-licenses hook (called at component top level). */
	useLicenses: () => LicensesState;
	/** Optional publisher A Major Pass revenue report. */
	useMembershipReport?: () => MarketplaceMembershipState;
	/** Optional seller-reports inbox for org admins. */
	useSellerReports?: () => SellerReportsState;
	/** The surface's seller-status hook (called at component top level). */
	useSellerStatus: () => SellerState;
}

const MarketplaceHostContext = createContext<MarketplaceHost | null>(null);

export function MarketplaceHostProvider({
	host,
	children,
}: {
	host: MarketplaceHost;
	children: ReactNode;
}) {
	// The likes store is mounted HERE rather than asked of each surface: a
	// surface that already provides the money layer gets the heart with no extra
	// wiring, and there is exactly one store per surface, which is what makes the
	// bulk batching work at all (sixty cards, one request).
	return (
		<MarketplaceHostContext.Provider value={host}>
			<LikesProvider service={host.likes}>
				{children}
				{host.purchaseDialog}
			</LikesProvider>
		</MarketplaceHostContext.Provider>
	);
}

/** Read the injected host services. Throws if no provider is mounted above. */
export function useMarketplaceHost(): MarketplaceHost {
	const host = useContext(MarketplaceHostContext);
	if (!host) {
		throw new Error(
			"useMarketplaceHost must be used within a <MarketplaceHostProvider>."
		);
	}
	return host;
}

/** Non-throwing accessor for the catalog sections, which render on surfaces that
 *  may not mount the money layer at all (the storyboard/test harnesses). Returns
 *  `null` rather than throwing, so a missing provider simply means "no reviews". */
export function useMarketplaceHostOptional(): MarketplaceHost | null {
	return useContext(MarketplaceHostContext);
}

export type { MarketplaceDetailTarget, MarketplaceLikesService };
