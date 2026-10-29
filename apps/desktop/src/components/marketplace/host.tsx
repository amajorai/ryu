// apps/desktop/src/components/marketplace/host.tsx
//
// Desktop binding for the shared @ryu/marketplace money-layer UI. Supplies the
// surface-specific services the shared components need: the owned-licenses and
// seller-status data hooks (Better-Auth bearer -> :3000), the purchase call, and
// Tauri's `openExternal` for the hosted Stripe URLs. The host is a stable module
// const so the hooks it carries keep a consistent identity across renders.

import type { MarketplaceCreatorsService } from "@ryu/marketplace/creators/types";
import {
	type MarketplaceHost,
	MarketplaceHostProvider,
	type MarketplaceLikesService,
	type MarketplaceReviewsService,
} from "@ryu/marketplace/host";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL, getActiveUserId } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useMarketplaceMembershipReport } from "@/src/hooks/useMarketplaceMembershipReport.ts";
import { useMyLicenses } from "@/src/hooks/useMyLicenses.ts";
import { useSellerReports } from "@/src/hooks/useSellerReports.ts";
import { useSellerStatus } from "@/src/hooks/useSellerStatus.ts";
import {
	deleteReview,
	fetchLikeCounts,
	fetchMarketplaceCreator,
	fetchMarketplaceCreators,
	fetchOwnCreatorProfile,
	fetchReviews,
	hasMarketplaceAuth,
	likeItem,
	postReview,
	saveOwnCreatorProfile,
	startPurchase,
	unlikeItem,
} from "@/src/lib/api/marketplace.ts";

/** Ratings + reviews, backed by the control plane (:3000) with the Better-Auth
 *  bearer. The wire has no "is this mine" flag — it returns each review's
 *  `userId` — so ownership is derived here against the active account, which is
 *  what gates the edit/delete affordances. */
const desktopReviews: MarketplaceReviewsService = {
	canWrite: hasMarketplaceAuth,
	list: async ({ kind, id, cursor, limit }) => {
		const page = await fetchReviews(kind, id, { cursor, limit });
		const me = getActiveUserId();
		return {
			nextCursor: page.nextCursor,
			ratingAverage: page.ratingAverage,
			ratingCount: page.ratingCount,
			reviews: page.reviews.map((r) => ({
				body: r.body,
				createdAt: r.createdAt,
				id: r.id,
				// Only claim ownership on a real match: a null `me` (signed out) must
				// never mark a review editable.
				mine: me !== null && r.userId === me,
				rating: r.rating,
				title: r.title,
				userName: r.userName,
				verifiedPurchase: r.verifiedPurchase,
			})),
		};
	},
	post: async (input) => {
		const result = await postReview(input);
		return {
			ratingAverage: result.ratingAverage,
			ratingCount: result.ratingCount,
		};
	},
	remove: ({ kind, id }) => deleteReview(kind, id),
	onSignIn: () => openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/login`),
};

/** The heart on a store card, backed by the control plane (:3000).
 *
 *  A SIGNED-OUT desktop still gets counts — the bulk read is public — so the
 *  control renders with its real number and only the WRITE needs a session. A
 *  signed-out click therefore prompts rather than failing silently: the desktop
 *  cannot navigate to a hosted login, so the prompt is a toast pointing at the
 *  account settings where sign-in lives. */
const desktopLikes: MarketplaceLikesService = {
	canLike: hasMarketplaceAuth,
	fetchCounts: fetchLikeCounts,
	like: likeItem,
	unlike: unlikeItem,
	onRequireAuth: () => {
		sileo.info({
			title: "Sign in to like items",
			description:
				"Likes are counted per account, so they need you signed in to your Ryu account.",
		});
	},
};

/** The Creators tab, backed by the control plane (:3000). Listing navigation
 *  is supplied by the Store page (it owns section switching), and the desktop
 *  has no follow model yet, so profiles render without a follow control. */
const desktopCreators: MarketplaceCreatorsService = {
	get: fetchMarketplaceCreator,
	list: fetchMarketplaceCreators,
	ownProfile: {
		load: fetchOwnCreatorProfile,
		save: saveOwnCreatorProfile,
	},
};

const desktopMarketplaceHost: MarketplaceHost = {
	creators: desktopCreators,
	likes: desktopLikes,
	openExternal,
	openMarketplace: () =>
		openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/marketplace`),
	openOrganization: () =>
		openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/organizations`),
	openSignIn: () => openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/login`),
	reviews: desktopReviews,
	startPurchase,
	useLicenses: useMyLicenses,
	useMembershipReport: useMarketplaceMembershipReport,
	useSellerStatus,
	useSellerReports,
};

/** Mount once above every store surface that renders the shared money layer. */
export function DesktopMarketplaceHost({ children }: { children: ReactNode }) {
	const stepUp = useStepUp();
	const host = useMemo(
		() => ({
			...desktopMarketplaceHost,
			guardPurchase: <T,>(action: () => Promise<T>) =>
				stepUp.guard("billing", action),
			purchaseDialog: stepUp.dialog,
		}),
		[stepUp.dialog, stepUp.guard]
	);
	return (
		<MarketplaceHostProvider host={host}>{children}</MarketplaceHostProvider>
	);
}
